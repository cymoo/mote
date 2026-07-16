use crate::config::UploadConfig;
use crate::model::drive::*;
use chrono::Utc;
use rand::RngCore;
use sqlx::{Row, SqlitePool};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use thiserror::Error as ThisError;
use uuid::Uuid;

const MAX_NAME_LEN: usize = 255;

#[derive(Debug, ThisError)]
pub enum DriveError {
    #[error("drive node not found")]
    NotFound,
    #[error("name already exists in this folder")]
    NameConflict,
    #[error("cannot move folder into its own descendant")]
    Cycle,
    #[error("parent must be a folder")]
    NotFolder,
    #[error("invalid name")]
    InvalidName,
    #[error("invalid parent folder")]
    InvalidParent,
    #[error("only files can be shared")]
    ShareInvalidNode,
    #[error("share not found")]
    ShareNotFound,
    #[error("share expired")]
    ShareExpired,
    #[error("wrong share password")]
    ShareWrongPassword,
    #[error("share has no password")]
    ShareNoPassword,
    #[error("upload session not found or expired")]
    UploadNotFound,
    #[error("chunk size mismatch")]
    UploadChunkSize,
    #[error("chunk index out of range")]
    UploadChunkOOR,
    #[error("upload is incomplete")]
    UploadIncomplete,
    #[error("final file size mismatch")]
    UploadFinalSize,
    #[error("file too large")]
    UploadTooLarge,
    #[error("invalid upload request")]
    UploadInvalidRequest,
    #[error("not an image")]
    NotImage,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("sqlx error: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

pub type DriveResult<T> = Result<T, DriveError>;

pub struct DriveService {
    pub pool: SqlitePool,
    pub config: UploadConfig,
}

impl DriveService {
    pub fn new(pool: SqlitePool, config: UploadConfig) -> Arc<Self> {
        std::fs::create_dir_all(Path::new(&config.base_path).join("drive"))
            .expect("create drive dir");
        std::fs::create_dir_all(Path::new(&config.base_path).join("drive").join("_chunks"))
            .expect("create drive/_chunks");
        std::fs::create_dir_all(Path::new(&config.base_path).join("drive").join("_thumbs"))
            .expect("create drive/_thumbs");
        Arc::new(Self { pool, config })
    }

    pub fn blob_abs_path(&self, rel: &str) -> PathBuf {
        Path::new(&self.config.base_path).join(rel)
    }

    pub async fn find_by_id(&self, id: i64) -> DriveResult<DriveNode> {
        let row = sqlx::query_as::<_, DriveNodeRow>("SELECT * FROM drive_nodes WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        match row {
            Some(r) => Ok(DriveNode::from_row(r)),
            None => Err(DriveError::NotFound),
        }
    }

    pub async fn list(
        &self,
        parent_id: Option<i64>,
        query: Option<&str>,
        order_by: &str,
        sort: &str,
    ) -> DriveResult<Vec<DriveNode>> {
        let q_trim = query.map(|s| s.trim()).filter(|s| !s.is_empty());
        let mut sql = String::from("SELECT * FROM drive_nodes WHERE ");
        let mut bind_pattern: Option<String> = None;
        let mut bind_pid: Option<i64> = None;

        if let Some(q) = q_trim {
            sql.push_str(r"deleted_at IS NULL AND LOWER(name) LIKE ? ESCAPE '\'");
            bind_pattern = Some(format!("%{}%", like_escape(&q.to_lowercase())));
        } else if let Some(pid) = parent_id {
            self.require_active_folder(pid).await?;
            sql.push_str("parent_id = ? AND deleted_at IS NULL");
            bind_pid = Some(pid);
        } else {
            sql.push_str("parent_id IS NULL AND deleted_at IS NULL");
        }

        let col = match order_by {
            "size" => "size",
            "updated_at" => "updated_at",
            "created_at" => "created_at",
            _ => "LOWER(name)",
        };
        let dir = if sort.eq_ignore_ascii_case("desc") {
            "DESC"
        } else {
            "ASC"
        };

        sql.push_str(&format!(
            " ORDER BY CASE WHEN type = 'folder' THEN 0 ELSE 1 END, {} {}, id ASC",
            col, dir
        ));

        let mut q = sqlx::query_as::<_, DriveNodeRow>(&sql);
        if let Some(p) = bind_pattern {
            q = q.bind(p);
        } else if let Some(pid) = bind_pid {
            q = q.bind(pid);
        }
        let rows = q.fetch_all(&self.pool).await?;

        let mut nodes: Vec<DriveNode> = rows.into_iter().map(DriveNode::from_row).collect();
        if q_trim.is_some() && !nodes.is_empty() {
            self.populate_paths(&mut nodes).await?;
        }
        if !nodes.is_empty() {
            self.populate_share_counts(&mut nodes).await?;
        }
        Ok(nodes)
    }

    /// Fills `share_count` with the number of currently active (non-expired)
    /// shares per node — files and folders alike.
    pub async fn populate_share_counts(&self, nodes: &mut [DriveNode]) -> DriveResult<()> {
        let ids: Vec<i64> = nodes.iter().map(|n| n.id).collect();
        if ids.is_empty() {
            return Ok(());
        }
        let now = Utc::now().timestamp_millis();
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT node_id, COUNT(*) AS c FROM drive_shares
             WHERE node_id IN ({}) AND (expires_at IS NULL OR expires_at > ?)
             GROUP BY node_id",
            placeholders
        );
        let mut q = sqlx::query(&sql);
        for id in &ids {
            q = q.bind(id);
        }
        q = q.bind(now);
        let rows = q.fetch_all(&self.pool).await?;
        let mut counts = std::collections::HashMap::new();
        for r in rows {
            let nid: i64 = r.try_get("node_id")?;
            let c: i64 = r.try_get("c")?;
            counts.insert(nid, c);
        }
        for n in nodes.iter_mut() {
            if let Some(&c) = counts.get(&n.id) {
                n.share_count = c;
            }
        }
        Ok(())
    }

    pub async fn populate_paths(&self, nodes: &mut [DriveNode]) -> DriveResult<()> {
        let parent_ids: Vec<i64> = nodes
            .iter()
            .filter_map(|n| n.parent_id)
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect();
        if parent_ids.is_empty() {
            return Ok(());
        }

        let parent_ids = serde_json::to_string(&parent_ids).map_err(anyhow::Error::from)?;
        let rows = sqlx::query(
            r#"
WITH RECURSIVE chain(parent_id, id, name, ancestor_parent_id, depth) AS (
  SELECT p.id, p.id, p.name, p.parent_id, 0
  FROM drive_nodes p
  WHERE p.id IN (SELECT value FROM json_each(?))
  UNION ALL
  SELECT chain.parent_id, n.id, n.name, n.parent_id, chain.depth + 1
  FROM drive_nodes n
  JOIN chain ON n.id = chain.ancestor_parent_id
)
SELECT parent_id, name
FROM chain
ORDER BY parent_id, depth DESC"#,
        )
        .bind(parent_ids)
        .fetch_all(&self.pool)
        .await?;

        let mut parts_by_parent: std::collections::HashMap<i64, Vec<String>> =
            std::collections::HashMap::new();
        for row in rows {
            let parent_id: i64 = row.try_get("parent_id")?;
            let name: String = row.try_get("name")?;
            parts_by_parent.entry(parent_id).or_default().push(name);
        }
        let paths: std::collections::HashMap<i64, String> = parts_by_parent
            .into_iter()
            .map(|(parent_id, parts)| (parent_id, parts.join("/")))
            .collect();

        for n in nodes.iter_mut() {
            if let Some(pid) = n.parent_id {
                n.path = paths.get(&pid).cloned().unwrap_or_default();
            }
        }

        Ok(())
    }

    pub async fn list_trash(&self) -> DriveResult<Vec<DriveNode>> {
        let rows = sqlx::query_as::<_, DriveNodeRow>(
            r#"
SELECT n.* FROM drive_nodes n
WHERE n.deleted_at IS NOT NULL
  AND (
    n.parent_id IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM drive_nodes p
      WHERE p.id = n.parent_id
        AND p.deleted_at IS NOT NULL
        AND p.delete_batch_id = n.delete_batch_id
    )
  )
ORDER BY n.deleted_at DESC, n.id DESC"#,
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(DriveNode::from_row).collect())
    }

    pub async fn breadcrumbs(&self, id: i64) -> DriveResult<Vec<DriveBreadcrumb>> {
        let rows = sqlx::query(
            r#"
WITH RECURSIVE chain(id, name, parent_id, depth) AS (
  SELECT id, name, parent_id, 0 FROM drive_nodes WHERE id = ?
  UNION ALL
  SELECT n.id, n.name, n.parent_id, c.depth + 1
  FROM drive_nodes n JOIN chain c ON n.id = c.parent_id
)
SELECT id, name FROM chain ORDER BY depth DESC"#,
        )
        .bind(id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| DriveBreadcrumb {
                id: r.try_get("id").unwrap_or(0),
                name: r.try_get("name").unwrap_or_default(),
            })
            .collect())
    }

    pub async fn create_folder(
        &self,
        parent_id: Option<i64>,
        name: &str,
    ) -> DriveResult<DriveNode> {
        valid_name(name)?;
        if let Some(pid) = parent_id {
            self.require_active_folder(pid).await?;
        }
        let now = Utc::now().timestamp_millis();
        let res = sqlx::query(
            "INSERT INTO drive_nodes (parent_id, type, name, created_at, updated_at)
             VALUES (?, 'folder', ?, ?, ?) RETURNING id",
        )
        .bind(parent_id)
        .bind(name)
        .bind(now)
        .bind(now)
        .fetch_one(&self.pool)
        .await
        .map_err(map_unique)?;
        let id: i64 = res.try_get("id")?;
        self.find_by_id(id).await
    }

    pub async fn rename(&self, id: i64, new_name: &str) -> DriveResult<()> {
        valid_name(new_name)?;
        let now = Utc::now().timestamp_millis();
        let res = sqlx::query(
            "UPDATE drive_nodes SET name = ?, updated_at = ?
             WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(new_name)
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(map_unique)?;
        if res.rows_affected() == 0 {
            return Err(DriveError::NotFound);
        }
        Ok(())
    }

    pub async fn move_nodes(&self, ids: &[i64], new_parent_id: Option<i64>) -> DriveResult<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let mut tx = self.pool.begin().await?;
        if let Some(pid) = new_parent_id {
            let row: Option<(String, Option<i64>)> =
                sqlx::query_as("SELECT type, deleted_at FROM drive_nodes WHERE id = ?")
                    .bind(pid)
                    .fetch_optional(&mut *tx)
                    .await?;
            let (typ, del) = row.ok_or(DriveError::InvalidParent)?;
            if del.is_some() {
                return Err(DriveError::InvalidParent);
            }
            if typ != "folder" {
                return Err(DriveError::NotFolder);
            }
        }
        let now = Utc::now().timestamp_millis();
        for &id in ids {
            if let Some(pid) = new_parent_id {
                if pid == id {
                    return Err(DriveError::Cycle);
                }
                let hit: i64 = sqlx::query_scalar(
                    r#"
WITH RECURSIVE descendants(id) AS (
  SELECT id FROM drive_nodes WHERE id = ?
  UNION ALL
  SELECT n.id FROM drive_nodes n JOIN descendants d ON n.parent_id = d.id
)
SELECT EXISTS(SELECT 1 FROM descendants WHERE id = ?)"#,
                )
                .bind(id)
                .bind(pid)
                .fetch_one(&mut *tx)
                .await?;
                if hit == 1 {
                    return Err(DriveError::Cycle);
                }
            }
            sqlx::query(
                "UPDATE drive_nodes SET parent_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
            )
            .bind(new_parent_id)
            .bind(now)
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(map_unique)?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn soft_delete(&self, ids: &[i64]) -> DriveResult<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let batch = new_token(16);
        let now = Utc::now().timestamp_millis();
        let mut tx = self.pool.begin().await?;
        for &id in ids {
            sqlx::query(
                r#"
WITH RECURSIVE subtree(id) AS (
  SELECT id FROM drive_nodes WHERE id = ? AND deleted_at IS NULL
  UNION ALL
  SELECT n.id FROM drive_nodes n JOIN subtree s ON n.parent_id = s.id
  WHERE n.deleted_at IS NULL
)
UPDATE drive_nodes
SET deleted_at = ?, delete_batch_id = ?, updated_at = ?
WHERE id IN (SELECT id FROM subtree)"#,
            )
            .bind(id)
            .bind(now)
            .bind(&batch)
            .bind(now)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn restore(&self, id: i64) -> DriveResult<()> {
        let n = self.find_by_id(id).await?;
        if n.deleted_at.is_none() {
            return Ok(());
        }
        let Some(batch) = n.delete_batch_id.clone() else {
            let hit: i64 = sqlx::query_scalar(
                r#"
SELECT EXISTS(
  SELECT 1 FROM drive_nodes
  WHERE COALESCE(parent_id, 0) = COALESCE(?, 0)
    AND LOWER(name) = LOWER(?)
    AND deleted_at IS NULL
)"#,
            )
            .bind(n.parent_id)
            .bind(&n.name)
            .fetch_one(&self.pool)
            .await?;
            if hit == 1 {
                return Err(DriveError::NameConflict);
            }
            sqlx::query(
                "UPDATE drive_nodes SET deleted_at = NULL, delete_batch_id = NULL WHERE id = ?",
            )
            .bind(id)
            .execute(&self.pool)
            .await?;
            return Ok(());
        };
        let mut tx = self.pool.begin().await?;
        let conflicts: i64 = sqlx::query_scalar(
            r#"
WITH RECURSIVE subtree(id) AS (
  SELECT id FROM drive_nodes WHERE id = ? AND deleted_at IS NOT NULL
  UNION ALL
  SELECT n.id FROM drive_nodes n JOIN subtree s ON n.parent_id = s.id
  WHERE n.deleted_at IS NOT NULL AND n.delete_batch_id = ?
)
SELECT COUNT(*)
FROM drive_nodes r
WHERE r.id IN (SELECT id FROM subtree)
  AND EXISTS (
    SELECT 1 FROM drive_nodes a
    WHERE COALESCE(a.parent_id, 0) = COALESCE(r.parent_id, 0)
      AND LOWER(a.name) = LOWER(r.name)
      AND a.deleted_at IS NULL
      AND a.id NOT IN (SELECT id FROM subtree)
  )"#,
        )
        .bind(id)
        .bind(&batch)
        .fetch_one(&mut *tx)
        .await?;
        if conflicts > 0 {
            return Err(DriveError::NameConflict);
        }
        sqlx::query(
            r#"
WITH RECURSIVE subtree(id) AS (
  SELECT id FROM drive_nodes WHERE id = ? AND deleted_at IS NOT NULL
  UNION ALL
  SELECT n.id FROM drive_nodes n JOIN subtree s ON n.parent_id = s.id
  WHERE n.deleted_at IS NOT NULL AND n.delete_batch_id = ?
)
UPDATE drive_nodes
SET deleted_at = NULL, delete_batch_id = NULL
WHERE id IN (SELECT id FROM subtree)"#,
        )
        .bind(id)
        .bind(&batch)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn purge(&self, ids: &[i64]) -> DriveResult<()> {
        for &id in ids {
            match self.purge_one(id).await {
                Ok(()) => {}
                // A node may already be gone when an ancestor earlier in the
                // batch cascade-deleted it — e.g. emptying a trash that holds
                // both a folder and its separately-batched deleted children.
                // Treat the already-removed node as successfully purged.
                Err(DriveError::NotFound) => continue,
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }

    async fn purge_one(&self, id: i64) -> DriveResult<()> {
        let mut tx = self.pool.begin().await?;
        let rows: Vec<(i64, Option<String>)> = sqlx::query_as(
            r#"
WITH RECURSIVE subtree(id) AS (
  SELECT id FROM drive_nodes WHERE id = ?
  UNION ALL
  SELECT n.id FROM drive_nodes n JOIN subtree s ON n.parent_id = s.id
)
SELECT n.id, n.blob_path FROM drive_nodes n WHERE n.id IN (SELECT id FROM subtree)"#,
        )
        .bind(id)
        .fetch_all(&mut *tx)
        .await?;
        if rows.is_empty() {
            return Err(DriveError::NotFound);
        }
        // Foreign keys cascade: deleting the root row removes descendants.
        sqlx::query("DELETE FROM drive_nodes WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;

        // Blobs can be shared by rows outside this subtree (copies, deduplicated
        // uploads). Decide which blobs became orphans INSIDE the tx — SQLite's
        // single writer serializes this against a concurrent copy — but remove
        // files only after commit so a rollback can't have deleted live data.
        let blobs: std::collections::HashSet<String> = rows
            .into_iter()
            .filter_map(|(_, b)| b.filter(|b| !b.is_empty()))
            .collect();
        let mut orphans = Vec::with_capacity(blobs.len());
        for blob in blobs {
            let refs: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM drive_nodes WHERE blob_path = ?")
                    .bind(&blob)
                    .fetch_one(&mut *tx)
                    .await?;
            if refs == 0 {
                orphans.push(blob);
            }
        }
        tx.commit().await?;

        for blob in orphans {
            let _ = std::fs::remove_file(self.blob_abs_path(&blob));
            self.purge_thumb(&blob);
        }
        Ok(())
    }

    /// Removes the blob file and its cached thumbnail when no drive_nodes row
    /// (active or trashed) references `blob_path` anymore. Blobs can be shared
    /// by several rows (copies, deduplicated uploads), so removal must always
    /// be gated on this check. Call it AFTER the rows that dropped the
    /// reference have been committed.
    pub async fn remove_blob_if_orphan(&self, blob_path: &str) {
        if blob_path.is_empty() {
            return;
        }
        let refs: Result<i64, _> =
            sqlx::query_scalar("SELECT COUNT(*) FROM drive_nodes WHERE blob_path = ?")
                .bind(blob_path)
                .fetch_one(&self.pool)
                .await;
        if !matches!(refs, Ok(0)) {
            return;
        }
        let _ = std::fs::remove_file(self.blob_abs_path(blob_path));
        self.purge_thumb(blob_path);
    }

    /// Returns the blob_path of an existing node (active or trashed) with the
    /// same content hash and size whose file is still present on disk, or None
    /// when there is none. Used to deduplicate uploads.
    pub async fn find_reusable_blob(&self, hash: &str, size: i64) -> DriveResult<Option<String>> {
        if hash.is_empty() {
            return Ok(None);
        }
        let candidates: Vec<String> = sqlx::query_scalar(
            "SELECT DISTINCT blob_path FROM drive_nodes
             WHERE hash = ? AND size = ? AND blob_path IS NOT NULL
             LIMIT 8",
        )
        .bind(hash)
        .bind(size)
        .fetch_all(&self.pool)
        .await?;
        for blob in candidates {
            if std::fs::metadata(self.blob_abs_path(&blob)).is_ok() {
                return Ok(Some(blob));
            }
        }
        Ok(None)
    }

    pub async fn collect_descendants(&self, root_id: i64) -> DriveResult<Vec<DescendantRow>> {
        let rows = sqlx::query_as::<_, DescendantRow>(
            r#"
WITH RECURSIVE subtree(id, type, name, blob_path, rel_path) AS (
  SELECT id, type, name, blob_path, name AS rel_path
  FROM drive_nodes WHERE id = ? AND deleted_at IS NULL
  UNION ALL
  SELECT n.id, n.type, n.name, n.blob_path, s.rel_path || '/' || n.name
  FROM drive_nodes n
  JOIN subtree s ON n.parent_id = s.id
  WHERE n.deleted_at IS NULL
)
SELECT id, type, name, blob_path, rel_path FROM subtree"#,
        )
        .bind(root_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    pub async fn require_active_folder(&self, id: i64) -> DriveResult<DriveNode> {
        let n = self.find_by_id(id).await?;
        if n.deleted_at.is_some() {
            return Err(DriveError::NotFound);
        }
        if n.r#type != "folder" {
            return Err(DriveError::NotFolder);
        }
        Ok(n)
    }

    pub async fn create_file_node(
        &self,
        parent_id: Option<i64>,
        name: &str,
        blob_path: &str,
        hash: &str,
        size: i64,
    ) -> DriveResult<DriveNode> {
        valid_name(name)?;
        if let Some(pid) = parent_id {
            self.require_active_folder(pid).await?;
        }
        let now = Utc::now().timestamp_millis();
        let res = sqlx::query(
            "INSERT INTO drive_nodes (parent_id, type, name, blob_path, size, hash, created_at, updated_at)
             VALUES (?, 'file', ?, ?, ?, NULLIF(?, ''), ?, ?) RETURNING id",
        )
        .bind(parent_id)
        .bind(name)
        .bind(blob_path)
        .bind(size)
        .bind(hash)
        .bind(now)
        .bind(now)
        .fetch_one(&self.pool)
        .await
        .map_err(map_unique)?;
        let id: i64 = res.try_get("id")?;
        self.find_by_id(id).await
    }

    pub async fn replace_file_node(
        &self,
        parent_id: Option<i64>,
        name: &str,
        blob_path: &str,
        hash: &str,
        size: i64,
    ) -> DriveResult<DriveNode> {
        valid_name(name)?;
        let mut tx = self.pool.begin().await?;
        let existing = sqlx::query_as::<_, DriveNodeRow>(
            "SELECT * FROM drive_nodes
             WHERE COALESCE(parent_id, 0) = COALESCE(?, 0)
               AND LOWER(name) = ?
               AND deleted_at IS NULL",
        )
        .bind(parent_id)
        .bind(name.to_lowercase())
        .fetch_optional(&mut *tx)
        .await?;
        let now = Utc::now().timestamp_millis();
        match existing {
            None => {
                let res = sqlx::query(
                    "INSERT INTO drive_nodes (parent_id, type, name, blob_path, size, hash, created_at, updated_at)
                     VALUES (?, 'file', ?, ?, ?, NULLIF(?, ''), ?, ?) RETURNING id",
                )
                .bind(parent_id)
                .bind(name)
                .bind(blob_path)
                .bind(size)
                .bind(hash)
                .bind(now)
                .bind(now)
                .fetch_one(&mut *tx)
                .await
                .map_err(map_unique)?;
                let id: i64 = res.try_get("id")?;
                tx.commit().await?;
                self.find_by_id(id).await
            }
            Some(ex) if ex.r#type != "file" => {
                // existing is a folder, can't overwrite — insert fresh (will conflict)
                let res = sqlx::query(
                    "INSERT INTO drive_nodes (parent_id, type, name, blob_path, size, hash, created_at, updated_at)
                     VALUES (?, 'file', ?, ?, ?, NULLIF(?, ''), ?, ?) RETURNING id",
                )
                .bind(parent_id)
                .bind(name)
                .bind(blob_path)
                .bind(size)
                .bind(hash)
                .bind(now)
                .bind(now)
                .fetch_one(&mut *tx)
                .await
                .map_err(map_unique)?;
                let id: i64 = res.try_get("id")?;
                tx.commit().await?;
                self.find_by_id(id).await
            }
            Some(ex) => {
                let old_blob = ex.blob_path.clone();
                sqlx::query(
                    "UPDATE drive_nodes SET blob_path = ?, size = ?, hash = NULLIF(?, ''), updated_at = ?
                     WHERE id = ?",
                )
                .bind(blob_path)
                .bind(size)
                .bind(hash)
                .bind(now)
                .bind(ex.id)
                .execute(&mut *tx)
                .await?;
                tx.commit().await?;
                // The old blob may still be referenced by other rows (copies,
                // deduplicated uploads) — only remove it once orphaned.
                if let Some(ob) = old_blob {
                    if !ob.is_empty() && ob != blob_path {
                        self.remove_blob_if_orphan(&ob).await;
                    }
                }
                self.find_by_id(ex.id).await
            }
        }
    }

    pub async fn find_active_sibling(
        &self,
        parent_id: Option<i64>,
        name: &str,
    ) -> DriveResult<Option<DriveNode>> {
        let row = sqlx::query_as::<_, DriveNodeRow>(
            "SELECT * FROM drive_nodes
             WHERE COALESCE(parent_id, 0) = COALESCE(?, 0)
               AND LOWER(name) = ?
               AND deleted_at IS NULL",
        )
        .bind(parent_id)
        .bind(name.to_lowercase())
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(DriveNode::from_row))
    }

    pub async fn auto_rename(&self, parent_id: Option<i64>, name: &str) -> DriveResult<String> {
        if self.find_active_sibling(parent_id, name).await?.is_none() {
            return Ok(name.to_string());
        }
        let p = Path::new(name);
        let ext = p
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        let stem = name.trim_end_matches(&ext).to_string();

        let prefix_pat = format!("{} (%", like_escape(&stem));
        let suffix_pat = format!("%){}", like_escape(&ext));
        let rows: Vec<(String,)> = sqlx::query_as(
            r"SELECT name FROM drive_nodes
              WHERE COALESCE(parent_id, 0) = COALESCE(?, 0)
                AND deleted_at IS NULL
                AND name LIKE ? ESCAPE '\'
                AND name LIKE ? ESCAPE '\'",
        )
        .bind(parent_id)
        .bind(prefix_pat)
        .bind(suffix_pat)
        .fetch_all(&self.pool)
        .await?;
        let mut max_n = 0;
        for (n,) in rows {
            let mid = n.trim_end_matches(&ext).to_string();
            if let Some(i) = mid.rfind(" (") {
                let num = mid[i + 2..].trim_end_matches(')');
                if let Ok(v) = num.parse::<i32>() {
                    if v > max_n {
                        max_n = v;
                    }
                }
            }
        }
        Ok(format!("{} ({}){}", stem, max_n + 1, ext))
    }

    // ---- copy / star / usage ----

    /// Deep-copies nodes into `new_parent_id` (None = root), one id at a time.
    /// File copies reference the SAME blob_path — zero disk cost; refcounted
    /// blob removal keeps shared blobs alive. Copies get fresh timestamps and
    /// never carry stars or shares. Copying a folder into its own subtree is
    /// rejected (Cycle), matching move. Destination name conflicts resolve via
    /// auto_rename ("name (1)"), so duplicate-in-place works naturally.
    pub async fn copy(
        &self,
        ids: &[i64],
        new_parent_id: Option<i64>,
    ) -> DriveResult<Vec<DriveNode>> {
        if let Some(pid) = new_parent_id {
            self.require_active_folder(pid).await?;
        }
        let mut out = Vec::with_capacity(ids.len());
        for &id in ids {
            out.push(self.copy_one(id, new_parent_id).await?);
        }
        Ok(out)
    }

    async fn copy_one(&self, id: i64, new_parent_id: Option<i64>) -> DriveResult<DriveNode> {
        let src = self.find_by_id(id).await?;
        if src.deleted_at.is_some() {
            return Err(DriveError::NotFound);
        }
        // Cycle check: copying a folder into itself or its own descendant would
        // mean copying the destination into itself; reject like move does.
        if let Some(pid) = new_parent_id {
            if src.r#type == "folder" {
                if pid == id {
                    return Err(DriveError::Cycle);
                }
                let hit: i64 = sqlx::query_scalar(
                    r#"
WITH RECURSIVE descendants(id) AS (
  SELECT id FROM drive_nodes WHERE id = ?
  UNION ALL
  SELECT n.id FROM drive_nodes n JOIN descendants d ON n.parent_id = d.id
)
SELECT EXISTS(SELECT 1 FROM descendants WHERE id = ?)"#,
                )
                .bind(id)
                .bind(pid)
                .fetch_one(&self.pool)
                .await?;
                if hit == 1 {
                    return Err(DriveError::Cycle);
                }
            }
        }

        // Pre-tx, read-only; the unique index backstops races (→ conflict error).
        let root_name = self.auto_rename(new_parent_id, &src.name).await?;

        let mut tx = self.pool.begin().await?;

        // Snapshot the whole source subtree up-front (depth-ordered so parents
        // are copied before children); inserting from the snapshot means freshly
        // created copies can never be re-visited.
        let snap: Vec<CopySnapRow> = sqlx::query_as(
            r#"
WITH RECURSIVE subtree(id, parent_id, type, name, blob_path, size, hash, depth) AS (
  SELECT id, parent_id, type, name, blob_path, size, hash, 0
  FROM drive_nodes WHERE id = ? AND deleted_at IS NULL
  UNION ALL
  SELECT n.id, n.parent_id, n.type, n.name, n.blob_path, n.size, n.hash, s.depth + 1
  FROM drive_nodes n JOIN subtree s ON n.parent_id = s.id
  WHERE n.deleted_at IS NULL
)
SELECT id, parent_id, type, name, blob_path, size, hash, depth
FROM subtree ORDER BY depth, id"#,
        )
        .bind(id)
        .fetch_all(&mut *tx)
        .await?;
        if snap.is_empty() {
            return Err(DriveError::NotFound);
        }

        let now = Utc::now().timestamp_millis();
        let mut id_map = std::collections::HashMap::with_capacity(snap.len());
        let mut new_root_id = 0i64;
        for r in &snap {
            let (parent_id, name) = if r.id == id {
                (new_parent_id, root_name.as_str())
            } else {
                let np = id_map.get(&r.parent_id.unwrap_or(0)).copied();
                (np, r.name.as_str())
            };
            let new_id: i64 = sqlx::query_scalar(
                "INSERT INTO drive_nodes (parent_id, type, name, blob_path, size, hash, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
            )
            .bind(parent_id)
            .bind(&r.r#type)
            .bind(name)
            .bind(&r.blob_path)
            .bind(r.size)
            .bind(&r.hash)
            .bind(now)
            .bind(now)
            .fetch_one(&mut *tx)
            .await
            .map_err(map_unique)?;
            id_map.insert(r.id, new_id);
            if r.id == id {
                new_root_id = new_id;
            }
        }
        tx.commit().await?;
        self.find_by_id(new_root_id).await
    }

    /// Walks/creates the folder chain `rel_path` ("a/b/c") under `parent_id`
    /// and returns the final folder. Get-or-create is idempotent: on a
    /// unique-constraint race the winner's row is re-selected. A path segment
    /// that exists as a FILE is a conflict (NameConflict) — auto-renaming would
    /// scatter one client directory across "dir"/"dir (1)" between calls.
    pub async fn ensure_folder_path(
        &self,
        parent_id: Option<i64>,
        rel_path: &str,
    ) -> DriveResult<DriveNode> {
        const MAX_DEPTH: usize = 32;
        let mut segs: Vec<&str> = Vec::with_capacity(8);
        for seg in rel_path.split('/') {
            let seg = seg.trim();
            if seg.is_empty() {
                continue;
            }
            valid_name(seg)?;
            segs.push(seg);
        }
        if segs.is_empty() || segs.len() > MAX_DEPTH {
            return Err(DriveError::InvalidName);
        }
        if let Some(pid) = parent_id {
            self.require_active_folder(pid).await?;
        }

        let mut cur = parent_id;
        let mut node = None;
        for seg in segs {
            let n = self.get_or_create_folder(cur, seg).await?;
            cur = Some(n.id);
            node = Some(n);
        }
        Ok(node.expect("segs is non-empty"))
    }

    async fn get_or_create_folder(
        &self,
        parent_id: Option<i64>,
        name: &str,
    ) -> DriveResult<DriveNode> {
        if let Some(existing) = self.find_active_sibling(parent_id, name).await? {
            if existing.r#type != "folder" {
                return Err(DriveError::NameConflict);
            }
            return Ok(existing);
        }
        match self.create_folder(parent_id, name).await {
            Err(DriveError::NameConflict) => {
                // A concurrent creator won the race — reuse their row.
                if let Ok(Some(again)) = self.find_active_sibling(parent_id, name).await {
                    if again.r#type == "folder" {
                        return Ok(again);
                    }
                }
                Err(DriveError::NameConflict)
            }
            res => res,
        }
    }

    /// Stars (starred=true) or unstars the given active nodes. Starring is a
    /// metadata toggle — it deliberately does not bump updated_at so the
    /// "modified" sort stays stable.
    pub async fn set_starred(&self, ids: &[i64], starred: bool) -> DriveResult<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let val: Option<i64> = starred.then(|| Utc::now().timestamp_millis());
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "UPDATE drive_nodes SET starred_at = ? WHERE id IN ({}) AND deleted_at IS NULL",
            placeholders
        );
        let mut q = sqlx::query(&sql).bind(val);
        for id in ids {
            q = q.bind(id);
        }
        q.execute(&self.pool).await?;
        Ok(())
    }

    /// Returns starred, non-deleted nodes (most recently starred first), with
    /// ancestor paths and share counts populated like search results.
    pub async fn list_starred(&self) -> DriveResult<Vec<DriveNode>> {
        let rows = sqlx::query_as::<_, DriveNodeRow>(
            "SELECT * FROM drive_nodes
             WHERE starred_at IS NOT NULL AND deleted_at IS NULL
             ORDER BY starred_at DESC, id DESC",
        )
        .fetch_all(&self.pool)
        .await?;
        let mut nodes: Vec<DriveNode> = rows.into_iter().map(DriveNode::from_row).collect();
        if !nodes.is_empty() {
            self.populate_paths(&mut nodes).await?;
            self.populate_share_counts(&mut nodes).await?;
        }
        Ok(nodes)
    }

    /// Reports drive storage consumption; see [`DriveUsage`].
    pub async fn usage(&self) -> DriveResult<DriveUsage> {
        let (active_bytes, active_count): (i64, i64) = sqlx::query_as(
            "SELECT COALESCE(SUM(size), 0), COUNT(*) FROM drive_nodes
             WHERE type = 'file' AND deleted_at IS NULL",
        )
        .fetch_one(&self.pool)
        .await?;
        let (trash_bytes, trash_count): (i64, i64) = sqlx::query_as(
            "SELECT COALESCE(SUM(size), 0), COUNT(*) FROM drive_nodes
             WHERE type = 'file' AND deleted_at IS NOT NULL",
        )
        .fetch_one(&self.pool)
        .await?;
        // Each distinct blob counted once — copies/deduplicated rows share blobs.
        let physical_bytes: i64 = sqlx::query_scalar(
            "SELECT COALESCE(SUM(sz), 0) FROM (
               SELECT MAX(size) AS sz FROM drive_nodes
               WHERE blob_path IS NOT NULL GROUP BY blob_path
             )",
        )
        .fetch_one(&self.pool)
        .await?;
        // Free/total space on the filesystem backing the uploads dir (df-style).
        let (free_bytes, total_bytes) = disk_space(&self.config.base_path);
        Ok(DriveUsage {
            active_bytes,
            trash_bytes,
            physical_bytes,
            active_count,
            trash_count,
            free_bytes,
            total_bytes,
        })
    }

    // ---- Thumbnails ----

    pub fn purge_thumb(&self, blob_path: &str) {
        if blob_path.is_empty() {
            return;
        }
        let base = Path::new(blob_path)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let p = Path::new(&self.config.base_path)
            .join("drive")
            .join("_thumbs")
            .join(format!("{}.jpg", base));
        let _ = std::fs::remove_file(p);
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct DescendantRow {
    pub id: i64,
    pub r#type: String,
    pub name: String,
    pub blob_path: Option<String>,
    pub rel_path: String,
}

/// One row of the depth-ordered subtree snapshot taken by `copy_one`.
#[derive(Debug, sqlx::FromRow)]
struct CopySnapRow {
    id: i64,
    parent_id: Option<i64>,
    r#type: String,
    name: String,
    blob_path: Option<String>,
    size: Option<i64>,
    hash: Option<String>,
    #[allow(dead_code)]
    depth: i64,
}

// ----- helpers -----

pub fn valid_name(name: &str) -> DriveResult<()> {
    let n = name.trim();
    if n.is_empty() || n == "." || n == ".." {
        return Err(DriveError::InvalidName);
    }
    if n.contains('/') || n.contains('\\') {
        return Err(DriveError::InvalidName);
    }
    if n.len() > MAX_NAME_LEN {
        return Err(DriveError::InvalidName);
    }
    Ok(())
}

pub fn like_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str(r"\\"),
            '%' => out.push_str(r"\%"),
            '_' => out.push_str(r"\_"),
            _ => out.push(c),
        }
    }
    out
}

pub fn new_token(n: usize) -> String {
    let mut buf = vec![0u8; n];
    rand::rngs::OsRng.fill_bytes(&mut buf);
    hex::encode(buf)
}

pub fn new_url_safe_token(n: usize) -> String {
    use base64::Engine;
    let mut buf = vec![0u8; n];
    rand::rngs::OsRng.fill_bytes(&mut buf);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

pub fn new_blob_name(original_name: &str) -> String {
    let ext = Path::new(original_name)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
        .unwrap_or_default();
    let id = Uuid::new_v4().simple().to_string();
    if ext.is_empty() {
        id
    } else {
        format!("{}{}", id, ext)
    }
}

pub fn sha256_hex(s: &str) -> String {
    use sha2::Digest;
    let h = sha2::Sha256::digest(s.as_bytes());
    hex::encode(h)
}

fn map_unique(e: sqlx::Error) -> DriveError {
    if is_unique_err(&e) {
        DriveError::NameConflict
    } else {
        DriveError::Sqlx(e)
    }
}

pub fn is_unique_err(e: &sqlx::Error) -> bool {
    if let sqlx::Error::Database(dbe) = e {
        if matches!(dbe.kind(), sqlx::error::ErrorKind::UniqueViolation) {
            return true;
        }
        let msg = dbe.message();
        if msg.contains("UNIQUE constraint failed") || msg.contains("constraint failed: UNIQUE") {
            return true;
        }
    }
    false
}

/// Reports the available and total bytes on the filesystem backing `path`
/// (df-style); returns (0, 0) when the platform lookup fails. Unix only.
fn disk_space(path: &str) -> (i64, i64) {
    match nix::sys::statvfs::statvfs(Path::new(path)) {
        Ok(st) => {
            let frsize = st.fragment_size();
            let free = (st.blocks_available() as u64).saturating_mul(frsize);
            let total = (st.blocks() as u64).saturating_mul(frsize);
            (free as i64, total as i64)
        }
        Err(_) => (0, 0),
    }
}
