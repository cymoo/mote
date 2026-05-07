#[cfg(test)]
mod tests {
    use mote::config::UploadConfig;
    use mote::service::drive_service::*;
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::SqlitePool;

    async fn setup() -> (SqlitePool, std::sync::Arc<DriveService>, tempfile::TempDir) {
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
        let svc = DriveService::new(pool.clone(), cfg);
        (pool, svc, tmp)
    }

    #[test]
    fn valid_name_rules() {
        assert!(valid_name("a.txt").is_ok());
        assert!(valid_name(" a ").is_ok());
        assert!(valid_name("").is_err());
        assert!(valid_name(".").is_err());
        assert!(valid_name("..").is_err());
        assert!(valid_name("a/b").is_err());
        assert!(valid_name("a\\b").is_err());
    }

    #[test]
    fn like_escape_basic() {
        assert_eq!(like_escape("a%b_c\\d"), "a\\%b\\_c\\\\d");
        assert_eq!(like_escape("plain"), "plain");
    }

    #[tokio::test]
    async fn folder_crud_happy_path() {
        let (_, svc, _tmp) = setup().await;
        let f = svc.create_folder(None, "docs").await.unwrap();
        assert_eq!(f.r#type, "folder");
        assert_eq!(f.name, "docs");

        // duplicate in same parent → conflict
        let err = svc.create_folder(None, "docs").await.unwrap_err();
        assert!(matches!(err, DriveError::NameConflict));

        // rename
        svc.rename(f.id, "papers").await.unwrap();
        let g = svc.find_by_id(f.id).await.unwrap();
        assert_eq!(g.name, "papers");

        // soft delete + restore
        svc.soft_delete(&[f.id]).await.unwrap();
        let g = svc.find_by_id(f.id).await.unwrap();
        assert!(g.deleted_at.is_some());
        svc.restore(f.id).await.unwrap();
        let g = svc.find_by_id(f.id).await.unwrap();
        assert!(g.deleted_at.is_none());
    }

    #[tokio::test]
    async fn auto_rename_collision() {
        let (_, svc, _tmp) = setup().await;
        svc.create_folder(None, "report.pdf").await.unwrap();
        // simulate a file collision check via auto_rename
        let n = svc.auto_rename(None, "report.pdf").await.unwrap();
        assert_eq!(n, "report (1).pdf");
    }
}
