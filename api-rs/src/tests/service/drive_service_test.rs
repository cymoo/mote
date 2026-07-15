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

    /// Writes a blob to disk and inserts a file node referencing it.
    async fn mk_file(
        svc: &DriveService,
        parent_id: Option<i64>,
        name: &str,
        blob_rel: &str,
        body: &[u8],
        hash: &str,
    ) -> mote::model::drive::DriveNode {
        let abs = svc.blob_abs_path(blob_rel);
        std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
        std::fs::write(&abs, body).unwrap();
        svc.create_file_node(parent_id, name, blob_rel, hash, body.len() as i64)
            .await
            .unwrap()
    }

    async fn insert_share(pool: &SqlitePool, node_id: i64, tk: &str) {
        sqlx::query(
            "INSERT INTO drive_shares (node_id, token_hash, token_prefix, expires_at, created_at)
             VALUES (?, ?, ?, NULL, 1)",
        )
        .bind(node_id)
        .bind(tk)
        .bind(tk)
        .execute(pool)
        .await
        .unwrap();
    }

    // Purging one of two nodes that share a blob (copy / deduplicated upload)
    // must keep the blob file; purging the last reference removes it.
    #[tokio::test]
    async fn purge_keeps_shared_blob() {
        let (_, svc, _tmp) = setup().await;

        let blob = "drive/shared.txt";
        let abs = svc.blob_abs_path(blob);
        let a = mk_file(&svc, None, "a.txt", blob, b"shared", "h").await;
        let b = mk_file(&svc, None, "b.txt", blob, b"shared", "h").await;

        svc.purge(&[a.id]).await.unwrap();
        assert!(abs.exists(), "blob removed while still referenced");

        svc.purge(&[b.id]).await.unwrap();
        assert!(
            !abs.exists(),
            "blob should be gone after last reference purged"
        );
    }

    // Overwriting one of two nodes that share a blob must not delete the blob
    // the other node still references; overwriting the last reference removes it.
    #[tokio::test]
    async fn replace_keeps_shared_blob() {
        let (_, svc, _tmp) = setup().await;

        let old_blob = "drive/old.txt";
        let new_blob = "drive/new.txt";
        mk_file(&svc, None, "a.txt", old_blob, b"old", "h").await;
        mk_file(&svc, None, "b.txt", old_blob, b"old", "h").await;
        std::fs::write(svc.blob_abs_path(new_blob), b"new").unwrap();

        // Overwrite a.txt with the new blob; the old blob is still used by b.txt.
        svc.replace_file_node(None, "a.txt", new_blob, "h2", 3)
            .await
            .unwrap();
        assert!(
            svc.blob_abs_path(old_blob).exists(),
            "shared old blob removed"
        );

        // Overwrite b.txt too — the old blob is now orphaned and must go.
        svc.replace_file_node(None, "b.txt", new_blob, "h2", 3)
            .await
            .unwrap();
        assert!(
            !svc.blob_abs_path(old_blob).exists(),
            "orphaned old blob should be removed"
        );
    }

    // A file copy shares the source's blob and never carries stars or shares.
    #[tokio::test]
    async fn copy_file_shares_blob_and_strips_meta() {
        let (pool, svc, _tmp) = setup().await;
        let dest = svc.create_folder(None, "dest").await.unwrap();

        let blob = "drive/src.txt";
        let src = mk_file(&svc, None, "src.txt", blob, b"x", "h").await;
        svc.set_starred(&[src.id], true).await.unwrap();
        insert_share(&pool, src.id, "tk").await;

        let out = svc.copy(&[src.id], Some(dest.id)).await.unwrap();
        assert_eq!(out.len(), 1);
        let cp = &out[0];
        assert_ne!(cp.id, src.id, "copy must be a fresh row");
        assert_eq!(
            cp.blob_path.as_deref(),
            Some(blob),
            "copy should share blob"
        );
        assert!(cp.starred_at.is_none(), "copy must not inherit the star");

        let shares: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM drive_shares WHERE node_id = ?")
            .bind(cp.id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(shares, 0, "copy must not inherit shares");
    }

    // Copying a folder replicates the whole subtree; the root gets auto-renamed
    // on destination conflicts while children keep their names.
    #[tokio::test]
    async fn copy_folder_recursive() {
        let (_, svc, _tmp) = setup().await;

        let a = svc.create_folder(None, "a").await.unwrap();
        let b = svc.create_folder(Some(a.id), "b").await.unwrap();
        let blob = "drive/c.txt";
        mk_file(&svc, Some(b.id), "c.txt", blob, b"c", "h").await;
        mk_file(&svc, Some(a.id), "d.txt", blob, b"c", "h").await;

        // Copy a → root: name "a" is taken by the source itself → "a (1)".
        let out = svc.copy(&[a.id], None).await.unwrap();
        let root = &out[0];
        assert_eq!(root.name, "a (1)");

        let l1 = svc.list(Some(root.id), None, "name", "asc").await.unwrap();
        assert_eq!(l1.len(), 2);
        assert_eq!(l1[0].name, "b");
        assert_eq!(l1[1].name, "d.txt");
        let l2 = svc.list(Some(l1[0].id), None, "name", "asc").await.unwrap();
        assert_eq!(l2.len(), 1);
        assert_eq!(l2[0].name, "c.txt");
        assert_eq!(l2[0].blob_path.as_deref(), Some(blob));
    }

    // Copying a folder into itself or its own descendant is rejected.
    #[tokio::test]
    async fn copy_into_own_subtree_rejected() {
        let (_, svc, _tmp) = setup().await;
        let a = svc.create_folder(None, "a").await.unwrap();
        let b = svc.create_folder(Some(a.id), "b").await.unwrap();

        let err = svc.copy(&[a.id], Some(b.id)).await.unwrap_err();
        assert!(matches!(err, DriveError::Cycle));
        let err = svc.copy(&[a.id], Some(a.id)).await.unwrap_err();
        assert!(matches!(err, DriveError::Cycle));
    }

    // Duplicate-in-place twice yields "x (1)" then "x (2)".
    #[tokio::test]
    async fn duplicate_in_place_twice() {
        let (_, svc, _tmp) = setup().await;
        let parent = svc.create_folder(None, "p").await.unwrap();

        let blob = "drive/x.txt";
        let src = mk_file(&svc, Some(parent.id), "x.txt", blob, b"x", "h").await;

        let c1 = svc.copy(&[src.id], Some(parent.id)).await.unwrap();
        let c2 = svc.copy(&[src.id], Some(parent.id)).await.unwrap();
        assert_eq!(c1[0].name, "x (1).txt");
        assert_eq!(c2[0].name, "x (2).txt");
    }

    // Star/unstar toggling, trash filtering, and the starred listing.
    #[tokio::test]
    async fn star_unstar_and_list() {
        let (_, svc, _tmp) = setup().await;

        let folder = svc.create_folder(None, "f").await.unwrap();
        let blob = "drive/s.txt";
        let file = mk_file(&svc, Some(folder.id), "s.txt", blob, b"s", "h").await;

        svc.set_starred(&[folder.id, file.id], true).await.unwrap();
        let out = svc.list_starred().await.unwrap();
        assert_eq!(out.len(), 2);
        for n in &out {
            if n.id == file.id {
                assert_eq!(n.path, "f");
            }
        }

        // Trashed items disappear from the listing but keep their star.
        svc.soft_delete(&[file.id]).await.unwrap();
        let out = svc.list_starred().await.unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, folder.id);
        svc.restore(file.id).await.unwrap();
        let out = svc.list_starred().await.unwrap();
        assert_eq!(out.len(), 2);

        // Unstar both.
        svc.set_starred(&[folder.id, file.id], false).await.unwrap();
        let out = svc.list_starred().await.unwrap();
        assert!(out.is_empty());
    }

    // Starring must not bump updated_at ("modified" sort stays stable).
    #[tokio::test]
    async fn star_does_not_touch_updated_at() {
        let (_, svc, _tmp) = setup().await;
        let folder = svc.create_folder(None, "f").await.unwrap();
        svc.set_starred(&[folder.id], true).await.unwrap();
        let got = svc.find_by_id(folder.id).await.unwrap();
        assert!(got.starred_at.is_some());
        assert_eq!(got.updated_at, folder.updated_at);
    }

    // ensure_folder_path creates missing segments, reuses existing ones
    // (case-insensitively), and refuses paths blocked by files or containing
    // invalid segments.
    #[tokio::test]
    async fn ensure_folder_path_walks_and_creates() {
        let (_, svc, _tmp) = setup().await;

        let leaf = svc.ensure_folder_path(None, "a/b/c").await.unwrap();
        assert_eq!(leaf.r#type, "folder");
        assert_eq!(leaf.name, "c");
        let bc = svc.breadcrumbs(leaf.id).await.unwrap();
        assert_eq!(bc.len(), 3);
        assert_eq!(bc[0].name, "a");
        assert_eq!(bc[1].name, "b");

        // Idempotent: the second call returns the same folder.
        let again = svc.ensure_folder_path(None, "a/b/c").await.unwrap();
        assert_eq!(again.id, leaf.id);

        // Case-insensitive reuse of existing segments.
        let b = svc.ensure_folder_path(None, "A/B").await.unwrap();
        assert_eq!(b.id, bc[1].id);

        // A file blocking the path → conflict, not auto-rename.
        mk_file(&svc, None, "block.txt", "drive/block.txt", b"x", "").await;
        let err = svc
            .ensure_folder_path(None, "block.txt/sub")
            .await
            .unwrap_err();
        assert!(matches!(err, DriveError::NameConflict));

        // Invalid segments rejected.
        let err = svc.ensure_folder_path(None, "../evil").await.unwrap_err();
        assert!(matches!(err, DriveError::InvalidName));
        let err = svc.ensure_folder_path(None, "///").await.unwrap_err();
        assert!(matches!(err, DriveError::InvalidName));
    }

    // Folder nodes now surface share counts too (folder shares).
    #[tokio::test]
    async fn share_counts_include_folders() {
        let (pool, svc, _tmp) = setup().await;
        let folder = svc.create_folder(None, "shared-folder").await.unwrap();
        insert_share(&pool, folder.id, "fh").await;

        let out = svc.list(None, None, "", "").await.unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].share_count, 1);
    }

    // Usage counts logical bytes per row but each distinct blob only once.
    #[tokio::test]
    async fn usage_counts_logical_and_physical() {
        let (_, svc, _tmp) = setup().await;

        let f1 = mk_file(&svc, None, "one.bin", "drive/x.bin", b"xxxxx", "hx").await;
        svc.copy(&[f1.id], None).await.unwrap(); // shares blob x
        let f3 = mk_file(&svc, None, "three.bin", "drive/y.bin", b"yyyyyyy", "hy").await;
        svc.soft_delete(&[f3.id]).await.unwrap();

        let u = svc.usage().await.unwrap();
        assert_eq!((u.active_bytes, u.active_count), (10, 2));
        assert_eq!((u.trash_bytes, u.trash_count), (7, 1));
        assert_eq!(u.physical_bytes, 12);
    }
}
