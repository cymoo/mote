use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use validator::Validate;

#[derive(Debug, Serialize, FromRow)]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub sticky: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize, FromRow)]
pub struct TagWithPostCount {
    pub name: String,
    pub sticky: bool,
    pub post_count: i64,
}

#[derive(Debug, Deserialize, Validate)]
pub struct RenameTagRequest {
    #[validate(length(min = 1, message = "can not be empty"))]
    pub name: String,
    #[validate(length(min = 1, message = "can not be empty"))]
    pub new_name: String,
}

#[derive(Debug, Deserialize, Validate)]
pub struct StickyTagRequest {
    #[validate(length(min = 1, message = "can not be empty"))]
    pub name: String,
    pub sticky: bool,
}
