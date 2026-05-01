use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use std::path::Path;

/// A folder or file in the drive tree. `mime_type` and `ext` are derived from
/// `name` at serialization time and are not stored in the database (matching
/// the Go implementation).
#[derive(Debug, Clone, FromRow)]
pub struct DriveNodeRow {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub r#type: String,
    pub name: String,
    pub blob_path: Option<String>,
    pub size: Option<i64>,
    pub hash: Option<String>,
    pub deleted_at: Option<i64>,
    pub delete_batch_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DriveNode {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub r#type: String,
    pub name: String,
    pub size: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub ext: Option<String>,
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub path: String,
    #[serde(skip_serializing_if = "is_zero")]
    pub share_count: i64,
    #[serde(skip)]
    pub blob_path: Option<String>,
    #[serde(skip)]
    pub delete_batch_id: Option<String>,
}

fn is_zero(v: &i64) -> bool {
    *v == 0
}

impl DriveNode {
    pub fn from_row(row: DriveNodeRow) -> Self {
        let (ext, mime) = if row.r#type == "file" {
            let e = ext_of(&row.name);
            let m = mime_for_ext(&e);
            (Some(e), Some(m))
        } else {
            (None, None)
        };
        DriveNode {
            id: row.id,
            parent_id: row.parent_id,
            r#type: row.r#type,
            name: row.name,
            size: row.size,
            hash: row.hash,
            deleted_at: row.deleted_at,
            created_at: row.created_at,
            updated_at: row.updated_at,
            ext,
            mime_type: mime,
            path: String::new(),
            share_count: 0,
            blob_path: row.blob_path,
            delete_batch_id: row.delete_batch_id,
        }
    }
}

pub fn ext_of(name: &str) -> String {
    Path::new(name)
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy().to_lowercase()))
        .unwrap_or_default()
}

pub fn mime_for_ext(ext: &str) -> String {
    let e = ext.trim_start_matches('.').to_lowercase();
    match e.as_str() {
        "html" | "htm" => "text/html; charset=utf-8".into(),
        "txt" => "text/plain; charset=utf-8".into(),
        "css" => "text/css; charset=utf-8".into(),
        "js" | "mjs" => "application/javascript".into(),
        "json" => "application/json".into(),
        "xml" => "application/xml".into(),
        "pdf" => "application/pdf".into(),
        "zip" => "application/zip".into(),
        "gz" | "tgz" => "application/gzip".into(),
        "tar" => "application/x-tar".into(),
        "rtf" => "application/rtf".into(),
        "csv" => "text/csv; charset=utf-8".into(),
        "md" | "markdown" => "text/markdown; charset=utf-8".into(),
        "png" => "image/png".into(),
        "jpg" | "jpeg" => "image/jpeg".into(),
        "gif" => "image/gif".into(),
        "webp" => "image/webp".into(),
        "bmp" => "image/bmp".into(),
        "tiff" | "tif" => "image/tiff".into(),
        "svg" => "image/svg+xml".into(),
        "ico" => "image/x-icon".into(),
        "mp3" => "audio/mpeg".into(),
        "wav" => "audio/wav".into(),
        "ogg" => "audio/ogg".into(),
        "flac" => "audio/flac".into(),
        "m4a" => "audio/mp4".into(),
        "mp4" => "video/mp4".into(),
        "webm" => "video/webm".into(),
        "mov" => "video/quicktime".into(),
        "mkv" => "video/x-matroska".into(),
        "avi" => "video/x-msvideo".into(),
        "doc" => "application/msword".into(),
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document".into(),
        "xls" => "application/vnd.ms-excel".into(),
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".into(),
        "ppt" => "application/vnd.ms-powerpoint".into(),
        "pptx" => {
            "application/vnd.openxmlformats-officedocument.presentationml.presentation".into()
        }
        "" => "application/octet-stream".into(),
        _ => "application/octet-stream".into(),
    }
}

#[derive(Debug, Clone, FromRow)]
pub struct DriveShareRow {
    pub id: i64,
    pub node_id: i64,
    pub token_hash: String,
    pub token_prefix: String,
    pub token: Option<String>,
    pub password_hash: Option<String>,
    pub expires_at: Option<i64>,
    pub created_at: i64,
}

#[derive(Debug, Clone, FromRow)]
pub struct DriveUpload {
    pub id: String,
    pub parent_id: Option<i64>,
    pub name: String,
    pub size: i64,
    pub chunk_size: i64,
    pub total_chunks: i64,
    pub received_mask: Vec<u8>,
    pub status: String,
    pub expires_at: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
pub struct DriveBreadcrumb {
    pub id: i64,
    pub name: String,
}

// ----- request DTOs -----

fn deserialize_optional_i64<'de, D: serde::Deserializer<'de>>(
    de: D,
) -> Result<Option<i64>, D::Error> {
    use serde::de::Error;
    let s: Option<serde_json::Value> = Option::deserialize(de)?;
    Ok(match s {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::Number(n)) => n.as_i64(),
        Some(serde_json::Value::String(s)) => {
            if s.is_empty() {
                None
            } else {
                Some(s.parse().map_err(D::Error::custom)?)
            }
        }
        _ => None,
    })
}

#[derive(Debug, Deserialize, Default)]
pub struct DriveListQuery {
    #[serde(default, deserialize_with = "deserialize_optional_i64")]
    pub parent_id: Option<i64>,
    pub q: Option<String>,
    #[serde(default)]
    pub order_by: String,
    #[serde(default)]
    pub sort: String,
}

#[derive(Debug, Deserialize)]
pub struct DriveIdQuery {
    pub id: i64,
}

#[derive(Debug, Deserialize)]
pub struct DriveCreateFolderRequest {
    pub parent_id: Option<i64>,
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct DriveRenameRequest {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct DriveMoveRequest {
    pub ids: Vec<i64>,
    pub new_parent_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct DriveIdsRequest {
    pub ids: Vec<i64>,
}

#[derive(Debug, Deserialize)]
pub struct DriveRestoreRequest {
    pub id: i64,
}

#[derive(Debug, Deserialize)]
pub struct DriveUploadInitRequest {
    pub parent_id: Option<i64>,
    pub name: String,
    pub size: i64,
    #[serde(default)]
    pub chunk_size: i64,
}

#[derive(Debug, Serialize)]
pub struct DriveUploadInitResponse {
    pub upload_id: String,
    pub total_chunks: i64,
    pub chunk_size: i64,
    pub received_chunks: Vec<i64>,
}

#[derive(Debug, Serialize)]
pub struct DriveUploadStatusResponse {
    pub upload_id: String,
    pub total_chunks: i64,
    pub chunk_size: i64,
    pub size: i64,
    pub received_chunks: Vec<i64>,
    pub status: String,
}

#[derive(Debug, Deserialize)]
pub struct DriveUploadCompleteRequest {
    pub upload_id: String,
    #[serde(default)]
    pub on_collision: String,
}

#[derive(Debug, Deserialize)]
pub struct DriveShareCreateRequest {
    pub node_id: i64,
    pub password: Option<String>,
    pub expires_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct DriveShareRevokeRequest {
    pub share_id: i64,
}

#[derive(Debug, Deserialize, Default)]
pub struct DriveSharesAllQuery {
    #[serde(default)]
    pub include_expired: bool,
}

#[derive(Debug, Serialize)]
pub struct DriveShareDTO {
    pub id: i64,
    pub node_id: i64,
    pub has_password: bool,
    pub expires_at: Option<i64>,
    pub created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DriveSharedItemDTO {
    pub id: i64,
    pub node_id: i64,
    pub parent_id: Option<i64>,
    pub has_password: bool,
    pub expires_at: Option<i64>,
    pub created_at: i64,
    pub name: String,
    pub size: i64,
    pub path: String,
    pub node_type: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip)]
    pub token: Option<String>,
}
