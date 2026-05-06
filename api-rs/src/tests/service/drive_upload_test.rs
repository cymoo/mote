#[cfg(test)]
mod tests {
    use mote::config::UploadConfig;
    use mote::model::drive::*;
    use mote::service::drive_service::DriveService;
    use mote::service::drive_upload_service::DriveUploadService;
    use sqlx::sqlite::SqlitePoolOptions;
    use std::io::Cursor;

    async fn setup() -> (
        std::sync::Arc<DriveService>,
        std::sync::Arc<DriveUploadService>,
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
        let upload = DriveUploadService::new(pool, drive.clone(), cfg);
        (drive, upload, tmp)
    }

    #[tokio::test]
    async fn upload_init_status_chunk_complete() {
        let (_drive, upload, _tmp) = setup().await;
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
        let (_drive, upload, _tmp) = setup().await;
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
}
