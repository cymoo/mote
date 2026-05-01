use crate::model::drive::{ext_of, mime_for_ext, DriveNode, DriveShareRow, DriveSharedItemDTO};
use crate::service::drive_service::{
    new_url_safe_token, sha256_hex, DriveError, DriveResult, DriveService,
};
use chrono::Utc;
use sqlx::SqlitePool;
use std::sync::Arc;
use subtle::ConstantTimeEq;

pub struct DriveShareService {
    pub pool: SqlitePool,
    pub drive: Arc<DriveService>,
}

pub struct CreatedShare {
    pub row: DriveShareRow,
    pub token: String,
    pub has_password: bool,
}

impl DriveShareService {
    pub fn new(pool: SqlitePool, drive: Arc<DriveService>) -> Arc<Self> {
        Arc::new(Self { pool, drive })
    }

    pub async fn create(
        &self,
        node_id: i64,
        password: Option<&str>,
        expires_at: Option<i64>,
    ) -> DriveResult<CreatedShare> {
        let n = self.drive.find_by_id(node_id).await?;
        if n.r#type != "file" {
            return Err(DriveError::ShareInvalidNode);
        }
        if n.deleted_at.is_some() {
            return Err(DriveError::NotFound);
        }
        let token = new_url_safe_token(32);
        let hash = sha256_hex(&token);
        let prefix = &hash[..8];
        let pw_hash = match password {
            Some(p) if !p.is_empty() => Some(
                bcrypt::hash(p, bcrypt::DEFAULT_COST)
                    .map_err(|e| DriveError::Other(anyhow::anyhow!(e)))?,
            ),
            _ => None,
        };
        let exp = expires_at.filter(|v| *v > 0);
        let now = Utc::now().timestamp_millis();
        let id: i64 = sqlx::query_scalar(
            "INSERT INTO drive_shares (node_id, token_hash, token_prefix, token, password_hash, expires_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
        )
        .bind(node_id)
        .bind(&hash)
        .bind(prefix)
        .bind(&token)
        .bind(&pw_hash)
        .bind(exp)
        .bind(now)
        .fetch_one(&self.pool)
        .await?;
        let row: DriveShareRow = sqlx::query_as("SELECT * FROM drive_shares WHERE id = ?")
            .bind(id)
            .fetch_one(&self.pool)
            .await?;
        let has_password = row.password_hash.is_some();
        Ok(CreatedShare {
            row,
            token,
            has_password,
        })
    }

    pub async fn list_by_node(&self, node_id: i64) -> DriveResult<Vec<DriveShareRow>> {
        let rows = sqlx::query_as::<_, DriveShareRow>(
            "SELECT * FROM drive_shares WHERE node_id = ? ORDER BY created_at DESC",
        )
        .bind(node_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    pub async fn revoke(&self, id: i64) -> DriveResult<()> {
        let res = sqlx::query("DELETE FROM drive_shares WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;
        if res.rows_affected() == 0 {
            return Err(DriveError::ShareNotFound);
        }
        Ok(())
    }

    pub async fn resolve(&self, token: &str) -> DriveResult<(DriveShareRow, DriveNode)> {
        if token.is_empty() {
            return Err(DriveError::ShareNotFound);
        }
        let hash = sha256_hex(token);
        let prefix = &hash[..8];
        let candidates =
            sqlx::query_as::<_, DriveShareRow>("SELECT * FROM drive_shares WHERE token_prefix = ?")
                .bind(prefix)
                .fetch_all(&self.pool)
                .await?;
        let h_bytes = hash.as_bytes();
        let m = candidates
            .into_iter()
            .find(|r| bool::from(r.token_hash.as_bytes().ct_eq(h_bytes)));
        let m = m.ok_or(DriveError::ShareNotFound)?;
        if let Some(exp) = m.expires_at {
            if exp < Utc::now().timestamp_millis() {
                return Err(DriveError::ShareExpired);
            }
        }
        let node = self.drive.find_by_id(m.node_id).await?;
        if node.deleted_at.is_some() || node.r#type != "file" {
            return Err(DriveError::ShareNotFound);
        }
        Ok((m, node))
    }

    pub fn verify_password(&self, share: &DriveShareRow, password: &str) -> DriveResult<()> {
        let Some(h) = share.password_hash.as_deref() else {
            return Err(DriveError::ShareNoPassword);
        };
        match bcrypt::verify(password, h) {
            Ok(true) => Ok(()),
            _ => Err(DriveError::ShareWrongPassword),
        }
    }

    pub async fn list_all(&self, include_expired: bool) -> DriveResult<Vec<DriveSharedItemDTO>> {
        let now = Utc::now().timestamp_millis();
        let sql_base = r#"
SELECT s.id, s.node_id, s.token, s.password_hash, s.expires_at, s.created_at,
       n.name AS name, COALESCE(n.size, 0) AS size, n.parent_id AS node_parent_id,
       n.type AS node_type
FROM drive_shares s
JOIN drive_nodes n ON n.id = s.node_id
WHERE n.deleted_at IS NULL"#;
        let rows = if include_expired {
            sqlx::query_as::<_, ShareJoinRow>(&format!("{} ORDER BY s.created_at DESC", sql_base))
                .fetch_all(&self.pool)
                .await?
        } else {
            sqlx::query_as::<_, ShareJoinRow>(&format!(
                "{} AND (s.expires_at IS NULL OR s.expires_at > ?) ORDER BY s.created_at DESC",
                sql_base
            ))
            .bind(now)
            .fetch_all(&self.pool)
            .await?
        };
        let mut out = Vec::with_capacity(rows.len());
        let mut path_cache: std::collections::HashMap<i64, String> =
            std::collections::HashMap::new();
        for r in rows {
            let path = if let Some(pid) = r.node_parent_id {
                if let Some(p) = path_cache.get(&pid) {
                    p.clone()
                } else {
                    let bcs = self.drive.breadcrumbs(pid).await?;
                    let p = bcs
                        .into_iter()
                        .map(|b| b.name)
                        .collect::<Vec<_>>()
                        .join("/");
                    path_cache.insert(pid, p.clone());
                    p
                }
            } else {
                String::new()
            };
            out.push(DriveSharedItemDTO {
                id: r.id,
                node_id: r.node_id,
                parent_id: r.node_parent_id,
                has_password: r.password_hash.is_some(),
                expires_at: r.expires_at,
                created_at: r.created_at,
                name: r.name.clone(),
                size: r.size,
                path,
                node_type: r.node_type.clone(),
                mime_type: if r.node_type == "file" {
                    mime_for_ext(&ext_of(&r.name))
                } else {
                    String::new()
                },
                url: None,
                token: r.token,
            });
        }
        Ok(out)
    }

    pub async fn purge_expired(&self) -> DriveResult<u64> {
        let now = Utc::now().timestamp_millis();
        let res = sqlx::query(
            "DELETE FROM drive_shares WHERE expires_at IS NOT NULL AND expires_at <= ?",
        )
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(res.rows_affected())
    }
}

#[derive(sqlx::FromRow)]
struct ShareJoinRow {
    id: i64,
    node_id: i64,
    token: Option<String>,
    password_hash: Option<String>,
    expires_at: Option<i64>,
    created_at: i64,
    name: String,
    size: i64,
    node_parent_id: Option<i64>,
    node_type: String,
}
