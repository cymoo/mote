use crate::config::UploadConfig;
use crate::model::drive::{
    DriveNode, DriveUpload, DriveUploadInitRequest,
};
use crate::service::drive_service::{
    new_blob_name, new_token, valid_name, DriveError, DriveResult, DriveService,
};
use chrono::Utc;
use sha2::Digest;
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const UPLOAD_TTL_MS: i64 = 24 * 60 * 60 * 1000;
const MAX_FILE_SIZE: i64 = 4 << 30;
const DEFAULT_CHUNK_SIZE: i64 = 8 << 20;

pub struct DriveUploadService {
    pub pool: SqlitePool,
    pub drive: Arc<DriveService>,
    pub config: UploadConfig,
}

impl DriveUploadService {
    pub fn new(pool: SqlitePool, drive: Arc<DriveService>, config: UploadConfig) -> Arc<Self> {
        Arc::new(Self { pool, drive, config })
    }

    fn chunks_dir(&self, upload_id: &str) -> PathBuf {
        Path::new(&self.config.base_path)
            .join("drive")
            .join("_chunks")
            .join(upload_id)
    }

    pub async fn init(&self, req: &DriveUploadInitRequest) -> DriveResult<DriveUpload> {
        valid_name(&req.name)?;
        if req.size <= 0 || req.size > MAX_FILE_SIZE {
            return Err(DriveError::UploadTooLarge);
        }
        let chunk = if req.chunk_size <= 0 {
            DEFAULT_CHUNK_SIZE
        } else {
            req.chunk_size
        };
        if !(1 << 20..=64 << 20).contains(&chunk) {
            return Err(DriveError::UploadInvalidRequest);
        }
        if let Some(pid) = req.parent_id {
            self.drive.require_active_folder(pid).await?;
        }
        let total = ((req.size + chunk - 1) / chunk) as i64;
        let mask = vec![0u8; ((total + 7) / 8) as usize];
        let id = new_token(16);
        let now = Utc::now().timestamp_millis();
        let expires = now + UPLOAD_TTL_MS;

        tokio::fs::create_dir_all(self.chunks_dir(&id)).await?;

        let res = sqlx::query(
            "INSERT INTO drive_uploads (id, parent_id, name, size, chunk_size, total_chunks, received_mask, status, expires_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?, ?)",
        )
        .bind(&id)
        .bind(req.parent_id)
        .bind(&req.name)
        .bind(req.size)
        .bind(chunk)
        .bind(total)
        .bind(&mask)
        .bind(expires)
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await;
        if let Err(e) = res {
            let _ = tokio::fs::remove_dir_all(self.chunks_dir(&id)).await;
            return Err(DriveError::Sqlx(e));
        }
        self.find(&id).await
    }

    pub async fn find(&self, id: &str) -> DriveResult<DriveUpload> {
        let u: Option<DriveUpload> =
            sqlx::query_as("SELECT * FROM drive_uploads WHERE id = ?")
                .bind(id)
                .fetch_optional(&self.pool)
                .await?;
        let u = u.ok_or(DriveError::UploadNotFound)?;
        if u.expires_at < Utc::now().timestamp_millis() {
            return Err(DriveError::UploadNotFound);
        }
        Ok(u)
    }

    pub async fn get_status(&self, id: &str) -> DriveResult<(DriveUpload, Vec<i64>)> {
        let u = self.find(id).await?;
        let received = decode_mask(&u.received_mask, u.total_chunks);
        Ok((u, received))
    }

    pub async fn put_chunk(
        &self,
        id: &str,
        idx: i64,
        mut body: impl tokio::io::AsyncRead + Unpin,
    ) -> DriveResult<()> {
        let u = self.find(id).await?;
        if u.status != "uploading" {
            return Err(DriveError::UploadInvalidRequest);
        }
        if idx < 0 || idx >= u.total_chunks {
            return Err(DriveError::UploadChunkOOR);
        }
        let expected = if idx == u.total_chunks - 1 {
            u.size - idx * u.chunk_size
        } else {
            u.chunk_size
        };

        let dir = self.chunks_dir(id);
        let tmp = dir.join(format!("{}.part", idx));
        let final_p = dir.join(format!("{}.bin", idx));

        let mut f = tokio::fs::File::create(&tmp).await?;
        let mut buf = vec![0u8; 64 * 1024];
        let mut written: i64 = 0;
        let limit = expected + 1;
        loop {
            let to_read = std::cmp::min(buf.len() as i64, limit - written) as usize;
            if to_read == 0 {
                break;
            }
            let n = body.read(&mut buf[..to_read]).await?;
            if n == 0 {
                break;
            }
            f.write_all(&buf[..n]).await?;
            written += n as i64;
        }
        f.flush().await?;
        drop(f);

        if written != expected {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(DriveError::UploadChunkSize);
        }
        tokio::fs::rename(&tmp, &final_p).await?;

        // Atomic mask OR via SQL.
        let byte_idx = (idx / 8) as i64;
        let bit_mask = 1i64 << (idx % 8);
        let now = Utc::now().timestamp_millis();
        // SQLite has no bitwise blob operators, but we can extract the byte and update.
        // Simplest correct approach: read+modify+write under BEGIN IMMEDIATE.
        let mut conn = self.pool.acquire().await?;
        sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;
        let mask: Vec<u8> = match sqlx::query_scalar::<_, Vec<u8>>(
            "SELECT received_mask FROM drive_uploads WHERE id = ?",
        )
        .bind(id)
        .fetch_one(&mut *conn)
        .await
        {
            Ok(m) => m,
            Err(e) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                return Err(DriveError::Sqlx(e));
            }
        };
        let mut mask = mask;
        if (byte_idx as usize) >= mask.len() {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            return Err(DriveError::UploadInvalidRequest);
        }
        mask[byte_idx as usize] |= bit_mask as u8;
        sqlx::query("UPDATE drive_uploads SET received_mask = ?, updated_at = ? WHERE id = ?")
            .bind(&mask)
            .bind(now)
            .bind(id)
            .execute(&mut *conn)
            .await?;
        sqlx::query("COMMIT").execute(&mut *conn).await?;
        Ok(())
    }

    pub async fn complete(
        &self,
        id: &str,
        on_collision: &str,
    ) -> DriveResult<DriveNode> {
        let u = self.find(id).await?;
        let now = Utc::now().timestamp_millis();
        let res = sqlx::query(
            "UPDATE drive_uploads SET status = 'assembling', updated_at = ?
             WHERE id = ? AND status = 'uploading'",
        )
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await?;
        if res.rows_affected() == 0 {
            return Err(DriveError::UploadInvalidRequest);
        }

        // Verify mask
        let mask: Vec<u8> =
            sqlx::query_scalar("SELECT received_mask FROM drive_uploads WHERE id = ?")
                .bind(id)
                .fetch_one(&self.pool)
                .await?;
        if (mask.len() as i64) * 8 < u.total_chunks {
            self.mark_uploading(id).await;
            return Err(DriveError::UploadInvalidRequest);
        }
        for i in 0..u.total_chunks {
            if mask[(i / 8) as usize] & (1 << (i % 8)) == 0 {
                self.mark_uploading(id).await;
                return Err(DriveError::UploadIncomplete);
            }
        }

        let parent_id = u.parent_id;
        if let Some(pid) = parent_id {
            if let Err(e) = self.drive.require_active_folder(pid).await {
                self.mark_uploading(id).await;
                return Err(e);
            }
        }
        let mut final_name = u.name.clone();
        let existing = self
            .drive
            .find_active_sibling(parent_id, &final_name)
            .await?;
        if existing.is_some() {
            match on_collision {
                "skip" => {
                    self.delete_session(id).await;
                    return Ok(existing.unwrap());
                }
                "rename" => {
                    final_name = self.drive.auto_rename(parent_id, &final_name).await?;
                }
                "overwrite" => {}
                _ => {
                    self.mark_uploading(id).await;
                    return Err(DriveError::NameConflict);
                }
            }
        }

        let blob_name = new_blob_name(&final_name);
        let rel_path = format!("drive/{}", blob_name);
        let abs_path = self.drive.blob_abs_path(&rel_path);
        let tmp_abs = abs_path.with_extension(format!(
            "{}.part",
            abs_path
                .extension()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default()
        ));

        let assembled = self.assemble(&u, &tmp_abs).await;
        let (hash, written) = match assembled {
            Ok(v) => v,
            Err(e) => {
                let _ = tokio::fs::remove_file(&tmp_abs).await;
                self.mark_uploading(id).await;
                return Err(e);
            }
        };
        if written != u.size {
            let _ = tokio::fs::remove_file(&tmp_abs).await;
            self.mark_uploading(id).await;
            return Err(DriveError::UploadFinalSize);
        }
        if let Err(e) = tokio::fs::rename(&tmp_abs, &abs_path).await {
            let _ = tokio::fs::remove_file(&tmp_abs).await;
            self.mark_uploading(id).await;
            return Err(DriveError::Io(e));
        }

        let node_res = if on_collision == "overwrite" {
            self.drive
                .replace_file_node(parent_id, &final_name, &rel_path, &hash, u.size)
                .await
        } else {
            self.drive
                .create_file_node(parent_id, &final_name, &rel_path, &hash, u.size)
                .await
        };
        match node_res {
            Ok(node) => {
                self.delete_session(id).await;
                Ok(node)
            }
            Err(e) => {
                let _ = tokio::fs::remove_file(&abs_path).await;
                self.mark_uploading(id).await;
                Err(e)
            }
        }
    }

    pub async fn cancel(&self, id: &str) -> DriveResult<()> {
        let res = sqlx::query("DELETE FROM drive_uploads WHERE id = ? AND status = 'uploading'")
            .bind(id)
            .execute(&self.pool)
            .await?;
        if res.rows_affected() == 0 {
            return Ok(());
        }
        let _ = tokio::fs::remove_dir_all(self.chunks_dir(id)).await;
        Ok(())
    }

    pub async fn purge_expired(&self) -> DriveResult<usize> {
        let now = Utc::now().timestamp_millis();
        let ids: Vec<(String,)> =
            sqlx::query_as("SELECT id FROM drive_uploads WHERE expires_at < ?")
                .bind(now)
                .fetch_all(&self.pool)
                .await?;
        let count = ids.len();
        for (id,) in ids {
            self.delete_session(&id).await;
        }
        Ok(count)
    }

    async fn delete_session(&self, id: &str) {
        let _ = sqlx::query("DELETE FROM drive_uploads WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await;
        let _ = tokio::fs::remove_dir_all(self.chunks_dir(id)).await;
    }

    async fn mark_uploading(&self, id: &str) {
        let _ = sqlx::query("UPDATE drive_uploads SET status = 'uploading' WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await;
    }

    async fn assemble(&self, u: &DriveUpload, out_path: &Path) -> DriveResult<(String, i64)> {
        let mut out = tokio::fs::File::create(out_path).await?;
        let mut hasher = sha2::Sha256::new();
        let mut total: i64 = 0;
        let dir = self.chunks_dir(&u.id);
        let mut buf = vec![0u8; 64 * 1024];
        for i in 0..u.total_chunks {
            let p = dir.join(format!("{}.bin", i));
            let mut f = tokio::fs::File::open(&p).await?;
            loop {
                let n = f.read(&mut buf).await?;
                if n == 0 {
                    break;
                }
                hasher.update(&buf[..n]);
                out.write_all(&buf[..n]).await?;
                total += n as i64;
            }
        }
        out.flush().await?;
        let hash = hex::encode(hasher.finalize());
        Ok((hash, total))
    }
}

fn decode_mask(mask: &[u8], total: i64) -> Vec<i64> {
    let mut out = Vec::with_capacity(total as usize);
    for i in 0..total {
        let byte = (i / 8) as usize;
        if byte >= mask.len() {
            break;
        }
        if mask[byte] & (1 << (i % 8)) != 0 {
            out.push(i);
        }
    }
    out
}
