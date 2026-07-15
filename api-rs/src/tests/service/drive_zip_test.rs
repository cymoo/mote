#[cfg(test)]
mod tests {
    use mote::config::UploadConfig;
    use mote::service::drive_service::{DriveError, DriveService};
    use mote::service::drive_zip_service::DriveZipService;
    use sqlx::sqlite::SqlitePoolOptions;
    use std::collections::HashMap;

    async fn setup() -> (
        std::sync::Arc<DriveService>,
        std::sync::Arc<DriveZipService>,
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
        let drive = DriveService::new(pool, cfg);
        let zip = DriveZipService::new(drive.clone());
        (drive, zip, tmp)
    }

    /// Writes a blob to disk and inserts a file node referencing it; returns the id.
    async fn mk_file(
        drive: &DriveService,
        parent_id: Option<i64>,
        name: &str,
        blob_rel: &str,
        body: &[u8],
    ) -> i64 {
        let abs = drive.blob_abs_path(blob_rel);
        std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
        std::fs::write(&abs, body).unwrap();
        drive
            .create_file_node(parent_id, name, blob_rel, "", body.len() as i64)
            .await
            .unwrap()
            .id
    }

    /// Runs zip_nodes over the resolved targets and returns entry name → bytes.
    async fn zip_to_entries(zip: &DriveZipService, ids: &[i64]) -> HashMap<String, Vec<u8>> {
        let targets = zip.resolve_zip_targets(ids).await.unwrap();
        let (writer, mut reader) = tokio::io::duplex(8 << 20);
        zip.zip_nodes(&targets, writer).await.unwrap();
        let mut buf = Vec::new();
        tokio::io::AsyncReadExt::read_to_end(&mut reader, &mut buf)
            .await
            .unwrap();
        read_zip(buf).await
    }

    async fn read_zip(buf: Vec<u8>) -> HashMap<String, Vec<u8>> {
        let reader = async_zip::base::read::mem::ZipFileReader::new(buf)
            .await
            .expect("invalid zip");
        let mut out = HashMap::new();
        for i in 0..reader.file().entries().len() {
            let name = reader.file().entries()[i]
                .filename()
                .as_str()
                .unwrap()
                .to_string();
            let mut er = reader.reader_with_entry(i).await.unwrap();
            let mut data = Vec::new();
            er.read_to_end_checked(&mut data).await.unwrap();
            out.insert(name, data);
        }
        out
    }

    // A mixed folder + file selection lands as top-level entries, with the
    // folder keeping its own name as the top-level directory.
    #[tokio::test]
    async fn zip_nodes_mixed_selection() {
        let (drive, zip, _tmp) = setup().await;

        let folder = drive.create_folder(None, "photos").await.unwrap();
        mk_file(&drive, Some(folder.id), "a.jpg", "drive/test_a.bin", b"aaa").await;
        let root_file = mk_file(&drive, None, "notes.txt", "drive/test_notes.bin", b"nnn").await;

        let got = zip_to_entries(&zip, &[folder.id, root_file]).await;

        let want: &[(&str, &[u8])] = &[
            ("photos/", b""),
            ("photos/a.jpg", b"aaa"),
            ("notes.txt", b"nnn"),
        ];
        for (k, v) in want {
            assert_eq!(
                got.get(*k).map(|b| b.as_slice()),
                Some(*v),
                "entry {:?}; all: {:?}",
                k,
                got.keys().collect::<Vec<_>>()
            );
        }
        assert_eq!(
            got.len(),
            want.len(),
            "all: {:?}",
            got.keys().collect::<Vec<_>>()
        );
    }

    // Ids nested under other selected folders are skipped, not doubled.
    #[tokio::test]
    async fn zip_nodes_skips_nested_selection() {
        let (drive, zip, _tmp) = setup().await;

        let outer = drive.create_folder(None, "outer").await.unwrap();
        let inner = drive.create_folder(Some(outer.id), "inner").await.unwrap();
        let nested_file = mk_file(
            &drive,
            Some(inner.id),
            "deep.txt",
            "drive/test_deep.bin",
            b"ddd",
        )
        .await;

        let got = zip_to_entries(&zip, &[outer.id, inner.id, nested_file]).await;

        let want: &[(&str, &[u8])] = &[
            ("outer/", b""),
            ("outer/inner/", b""),
            ("outer/inner/deep.txt", b"ddd"),
        ];
        assert_eq!(
            got.len(),
            want.len(),
            "all: {:?}",
            got.keys().collect::<Vec<_>>()
        );
        for (k, v) in want {
            assert_eq!(got.get(*k).map(|b| b.as_slice()), Some(*v), "entry {:?}", k);
        }
    }

    // Same-named top-level picks (possible from search-result selections) get
    // suffixed instead of silently dropped.
    #[tokio::test]
    async fn zip_nodes_duplicate_top_level_suffixed() {
        let (drive, zip, _tmp) = setup().await;

        let f1 = drive.create_folder(None, "one").await.unwrap();
        let f2 = drive.create_folder(None, "two").await.unwrap();
        let a = mk_file(
            &drive,
            Some(f1.id),
            "dup.txt",
            "drive/test_dup_a.bin",
            b"first",
        )
        .await;
        let b = mk_file(
            &drive,
            Some(f2.id),
            "dup.txt",
            "drive/test_dup_b.bin",
            b"second",
        )
        .await;

        let got = zip_to_entries(&zip, &[a, b]).await;

        assert_eq!(
            got.get("dup.txt").map(|b| b.as_slice()),
            Some(b"first".as_slice())
        );
        assert_eq!(
            got.get("dup (1).txt").map(|b| b.as_slice()),
            Some(b"second".as_slice())
        );
    }

    // A fully deleted/missing selection resolves to NotFound before any body
    // byte would be written.
    #[tokio::test]
    async fn zip_nodes_empty_selection_not_found() {
        let (drive, zip, _tmp) = setup().await;
        let folder = drive.create_folder(None, "gone").await.unwrap();
        drive.soft_delete(&[folder.id]).await.unwrap();

        let err = zip
            .resolve_zip_targets(&[folder.id, 9999])
            .await
            .unwrap_err();
        assert!(matches!(err, DriveError::NotFound));
    }
}
