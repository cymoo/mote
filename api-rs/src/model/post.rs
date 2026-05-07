use crate::model::validator::validate_date_format;
use crate::util::maybe::MaybeAbsent;
use derive_more::Display;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use validator::Validate;

// which Rust types correspond to which sqlite column types:
// https://docs.rs/sqlx/latest/sqlx/sqlite/types/index.html
#[derive(Debug, Serialize, FromRow, Clone)]
pub struct PostRow {
    pub id: i64,
    pub content: String,
    #[serde(serialize_with = "serialize_raw_json")]
    pub files: Option<String>,
    pub color: Option<String>,
    pub shared: bool,
    pub deleted_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip_serializing)]
    pub parent_id: Option<i64>,
    pub children_count: i64,
}

#[derive(Debug, Serialize, Clone)]
pub struct Post {
    #[serde(flatten)]
    pub row: PostRow,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<Box<Post>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,

    pub tags: Vec<String>,
}

impl From<PostRow> for Post {
    fn from(row: PostRow) -> Self {
        Self {
            row,
            parent: None,
            score: None,
            tags: vec![],
        }
    }
}

#[derive(Debug, Deserialize, Display)]
#[serde(rename_all = "snake_case")]
pub enum CategoryColor {
    #[display("red")]
    Red,
    #[display("blue")]
    Blue,
    #[display("green")]
    Green,
}

#[derive(Debug, Deserialize, Display, Default)]
#[serde(rename_all = "snake_case")]
pub enum SortingField {
    #[default]
    #[display("created_at")]
    CreatedAt,
    #[display("updated_at")]
    UpdatedAt,
    #[display("deleted_at")]
    DeletedAt,
}

#[derive(Debug, Deserialize, Validate)]
pub struct Id {
    pub id: i64,
}

#[derive(Debug, Deserialize, Validate)]
pub struct Name {
    #[validate(length(min = 1, message = "can not be empty"))]
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub password: String,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct FileInfo {
    pub url: String,
    pub thumb_url: Option<String>,
    pub size: Option<u64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Debug, Deserialize, Validate)]
pub struct SearchRequest {
    #[validate(length(min = 1, message = "can not be empty"))]
    pub query: String,
    pub limit: Option<usize>,
    pub partial: Option<bool>,
}

#[derive(Debug, Deserialize, Default, Validate)]
#[serde(default)]
pub struct FilterPostRequest {
    pub cursor: Option<i64>,
    pub deleted: bool,
    pub parent_id: Option<i64>,
    pub color: Option<CategoryColor>,
    pub tag: Option<String>,
    pub shared: Option<bool>,
    pub has_files: Option<bool>,
    pub order_by: SortingField,
    pub ascending: bool,
    pub start_date: Option<i64>,
    pub end_date: Option<i64>,
}

#[derive(Debug, Deserialize, Validate)]
pub struct CreatePostRequest {
    #[validate(length(min = 1, message = "can not be empty"))]
    pub content: String,
    pub files: Option<Vec<FileInfo>>,
    pub color: Option<CategoryColor>,
    pub shared: Option<bool>,
    pub parent_id: Option<i64>,
}

#[derive(Debug, Deserialize, Validate)]
pub struct UpdatePostRequest {
    pub id: i64,

    #[serde(default)]
    pub content: MaybeAbsent<String>,

    #[serde(default)]
    pub shared: MaybeAbsent<bool>,

    #[serde(default)]
    pub files: MaybeAbsent<Option<Vec<FileInfo>>>,
    #[serde(default)]
    pub color: MaybeAbsent<Option<CategoryColor>>,
    #[serde(default)]
    pub parent_id: MaybeAbsent<Option<i64>>,
}

#[derive(Debug, Deserialize, Validate)]
pub struct DeletePostRequest {
    pub id: i64,
    #[serde(default)]
    pub hard: bool,
}

#[derive(Debug, Deserialize, Validate)]
pub struct DateRange {
    #[validate(custom(function = "validate_date_format"))]
    pub start_date: String,
    #[validate(custom(function = "validate_date_format"))]
    pub end_date: String,
    pub offset: i32,
}

#[derive(Debug, Serialize)]
pub struct CreateResponse {
    pub id: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
pub struct PostPagination {
    pub posts: Vec<Post>,
    pub cursor: i64,
    pub size: i64,
}

#[derive(Debug, Serialize)]
pub struct PostStats {
    pub post_count: i64,
    pub tag_count: i64,
    pub day_count: i64,
}

fn serialize_raw_json<S>(value: &Option<String>, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    match value {
        Some(v) => {
            let json: serde_json::Value =
                serde_json::from_str(v).unwrap_or(serde_json::Value::Null);
            json.serialize(serializer)
        }
        None => serializer.serialize_none(),
    }
}
