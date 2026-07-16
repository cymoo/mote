#[cfg(test)]
mod tests {
    use mote::config::UploadConfig;
    use mote::model::drive::*;
    use mote::service::drive_service::DriveService;
    use mote::service::drive_share_service::DriveShareService;
    use mote::service::drive_upload_service::DriveUploadService;
    use sqlx::sqlite::SqlitePoolOptions;
    use std::io::Cursor;

    async fn setup() -> (
        std::sync::Arc<DriveService>,
        std::sync::Arc<DriveUploadService>,
        std::sync::Arc<DriveShareService>,
        tempfile::TempDir,
    ) {
        let tmp = tempfile::tempdir().unwrap();
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let cfg = UploadConfig {
            base_url: "/uploads".into(),
            base_path: tmp.path().to_string_lossy().into(),
            accel_redirect_prefix: String::new(),
            thumb_width: 240,
            image_formats: vec![],
        };
        let drive = DriveService::new(pool.clone(), cfg.clone());
        let upload = DriveUploadService::new(pool.clone(), drive.clone(), cfg);
        let share = DriveShareService::new(pool, drive.clone());
        (drive, upload, share, tmp)
    }

    /// Runs init → chunk(s) → complete and returns the resulting node.
    async fn perform_upload(
        upload: &DriveUploadService,
        parent_id: Option<i64>,
        name: &str,
        content: &[u8],
        chunk_size: i64,
        on_collision: &str,
    ) -> DriveNode {
        let init = upload
            .init(&DriveUploadInitRequest {
                parent_id,
                name: name.into(),
                size: content.len() as i64,
                chunk_size,
            })
            .await
            .unwrap();
        for i in 0..init.total_chunks {
            let start = (i * chunk_size) as usize;
            let end = std::cmp::min(start + chunk_size as usize, content.len());
            upload
                .put_chunk(&init.id, i, Cursor::new(content[start..end].to_vec()))
                .await
                .unwrap();
        }
        upload.complete(&init.id, on_collision).await.unwrap()
    }

    #[tokio::test]
    async fn upload_init_status_chunk_complete() {
        let (_drive, upload, _share, _tmp) = setup().await;
        let payload = b"hello world, this is a small test file.".to_vec();
        let init = upload
            .init(&DriveUploadInitRequest {
                parent_id: None,
                name: "hello.txt".into(),
                size: payload.len() as i64,
                chunk_size: 0,
            })
            .await
            .unwrap();
        assert_eq!(init.total_chunks, 1);

        upload
            .put_chunk(&init.id, 0, Cursor::new(payload.clone()))
            .await
            .unwrap();

        let (_, recv) = upload.get_status(&init.id).await.unwrap();
        assert_eq!(recv, vec![0]);

        let node = upload.complete(&init.id, "rename").await.unwrap();
        assert_eq!(node.r#type, "file");
        assert_eq!(node.name, "hello.txt");
        assert_eq!(node.size.unwrap_or(0), payload.len() as i64);
    }

    #[tokio::test]
    async fn upload_init_rejects_bad_chunk_size() {
        let (_drive, upload, _share, _tmp) = setup().await;
        let err = upload
            .init(&DriveUploadInitRequest {
                parent_id: None,
                name: "x.bin".into(),
                size: 100,
                chunk_size: 8,
            })
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            mote::service::drive_service::DriveError::UploadInvalidRequest
        ));
    }

    // Two uploads with identical content must share one blob on disk.
    #[tokio::test]
    async fn dedup_reuses_blob() {
        let (drive, upload, _share, _tmp) = setup().await;
        let body = b"identical bytes";

        let n1 = perform_upload(&upload, None, "one.txt", body, 1 << 20, "ask").await;
        let n2 = perform_upload(&upload, None, "two.txt", body, 1 << 20, "ask").await;

        assert_eq!(
            n2.blob_path, n1.blob_path,
            "expected shared blob, got {:?} vs {:?}",
            n1.blob_path, n2.blob_path
        );
        // Exactly one blob file in drive/ (chunks/thumbs live in subdirectories).
        let files = std::fs::read_dir(drive.blob_abs_path("drive"))
            .unwrap()
            .filter(|e| e.as_ref().unwrap().file_type().unwrap().is_file())
            .count();
        assert_eq!(files, 1, "expected 1 blob file");
    }

    // Dedup must skip candidates whose blob no longer exists on disk.
    #[tokio::test]
    async fn dedup_skips_missing_blob_on_disk() {
        let (drive, upload, _share, _tmp) = setup().await;
        let body = b"payload to lose";

        let n1 = perform_upload(&upload, None, "one.txt", body, 1 << 20, "ask").await;
        // Simulate external deletion of the stored blob.
        std::fs::remove_file(drive.blob_abs_path(n1.blob_path.as_deref().unwrap())).unwrap();

        let n2 = perform_upload(&upload, None, "two.txt", body, 1 << 20, "ask").await;
        assert_ne!(n2.blob_path, n1.blob_path, "must not reuse a missing blob");
        assert!(
            drive
                .blob_abs_path(n2.blob_path.as_deref().unwrap())
                .exists(),
            "fresh blob missing"
        );
    }

    // Overwriting a file with identical content dedups against the very blob
    // being replaced and must not delete it.
    #[tokio::test]
    async fn dedup_overwrite_same_content() {
        let (drive, upload, _share, _tmp) = setup().await;
        let body = b"same content twice";

        let n1 = perform_upload(&upload, None, "dup.txt", body, 1 << 20, "ask").await;
        let n2 = perform_upload(&upload, None, "dup.txt", body, 1 << 20, "overwrite").await;

        assert_eq!(
            n2.blob_path, n1.blob_path,
            "expected overwrite to reuse the identical blob"
        );
        let got = std::fs::read(drive.blob_abs_path(n2.blob_path.as_deref().unwrap()))
            .expect("blob gone after self-overwrite");
        assert_eq!(got, body, "content mismatch after overwrite");
    }

    // Folders can be shared and resolve back to the folder node.
    #[tokio::test]
    async fn share_folder_create_and_resolve() {
        let (drive, _upload, share, _tmp) = setup().await;
        let folder = drive.create_folder(None, "Pics").await.unwrap();

        let sh = share.create(folder.id, None, None).await.unwrap();
        let (_, node) = share.resolve(&sh.token).await.unwrap();
        assert_eq!(node.id, folder.id);
        assert_eq!(node.r#type, "folder");
    }

    // resolve_child gates every ?id=/?dir= on the public folder-share surface:
    // only the share root itself and its ACTIVE descendants may resolve.
    #[tokio::test]
    async fn share_resolve_child_scope() {
        use mote::service::drive_service::DriveError;
        let (drive, upload, share, _tmp) = setup().await;

        let root = drive.create_folder(None, "root").await.unwrap();
        let sub = drive.create_folder(Some(root.id), "sub").await.unwrap();
        let inner = perform_upload(&upload, Some(sub.id), "in.txt", b"in", 1 << 20, "ask").await;
        let outside = perform_upload(&upload, None, "out.txt", b"out", 1 << 20, "ask").await;

        // The root itself resolves.
        let n = share.resolve_child(root.id, root.id).await.unwrap();
        assert_eq!(n.id, root.id);
        // An active descendant resolves.
        let n = share.resolve_child(root.id, inner.id).await.unwrap();
        assert_eq!(n.id, inner.id);
        // A node outside the share subtree → not found.
        let err = share.resolve_child(root.id, outside.id).await.unwrap_err();
        assert!(matches!(err, DriveError::ShareNotFound));
        // A trashed descendant → not found.
        drive.soft_delete(&[inner.id]).await.unwrap();
        let err = share.resolve_child(root.id, inner.id).await.unwrap_err();
        assert!(matches!(err, DriveError::ShareNotFound));
        // A child inside a trashed folder → not found (the deleted hop breaks
        // the chain).
        let f2 = drive.create_folder(Some(root.id), "f2").await.unwrap();
        let leaf = perform_upload(&upload, Some(f2.id), "leaf.txt", b"leaf", 1 << 20, "ask").await;
        drive.soft_delete(&[f2.id]).await.unwrap();
        let err = share.resolve_child(root.id, leaf.id).await.unwrap_err();
        assert!(matches!(err, DriveError::ShareNotFound));
    }
}
