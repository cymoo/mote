use crate::model::post::{FileInfo, PostRow};
use crate::util::env::get_env_or;
use crate::util::extractor::Path;
use crate::AppState;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::{Extension, Router};
use chrono::{Local, TimeZone};
#[cfg(not(debug_assertions))]
use include_dir::{include_dir, Dir};
use lazy_static::lazy_static;
use minijinja::{context, Environment};
use regex::Regex;
use serde::Serialize;
use tracing::error;

type HtmlResult = Result<Html<String>, HtmlError>;

pub fn create_routes() -> Router<AppState> {
    let mut env = Environment::new();
    load_templates(&mut env);

    Router::new()
        .route("/", get(post_list))
        .route("/{id}", get(post_item))
        .layer(Extension(env))
}

#[derive(Debug, Serialize)]
struct PostMetaData {
    id: i64,
    title: Option<String>,
    description: Option<String>,
    created_at: String,
}

async fn post_list(
    State(state): State<AppState>,
    Extension(env): Extension<Environment<'_>>,
) -> HtmlResult {
    let posts = sqlx::query_as!(
        PostRow,
        r#"
        SELECT * FROM posts
        WHERE shared = true AND deleted_at IS NULL
        ORDER BY created_at DESC
        "#
    )
    .fetch_all(&state.db.pool)
    .await?;

    let mut result = Vec::new();

    for post in posts.iter() {
        let (title, description) = extract_header_and_description_from_html(&post.content);
        result.push(PostMetaData {
            id: post.id,
            title,
            description,
            created_at: timestamp_to_local_date(post.created_at / 1000),
        })
    }

    let about_url = get_env_or("ABOUT_URL", "".to_string())?;
    let template = env.get_template("post-list.html")?;

    Ok(Html(template.render(context! {
        about_url,
        posts => result,
    })?))
}

async fn post_item(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Extension(env): Extension<Environment<'_>>,
) -> HtmlResult {
    let post = sqlx::query_as!(
        PostRow,
        r#"
        SELECT * FROM posts
        WHERE id = ? AND deleted_at IS NULL AND shared IS TRUE
        "#,
        id
    )
    .fetch_optional(&state.db.pool)
    .await?;

    let post = post
        .as_ref()
        .filter(|p| p.deleted_at.is_none())
        .ok_or(HtmlError::NotFound)?;

    let (title, _) = extract_header_and_description_from_html(&post.content);

    let images: Vec<FileInfo> = match post.files {
        Some(ref files) => serde_json::from_str(files).expect("JSON decode error"),
        None => vec![],
    };

    let about_url = get_env_or("ABOUT_URL", "".to_string())?;
    let template = env.get_template("post-item.html")?;

    Ok(Html(
        template.render(context! { about_url, post, title, images })?,
    ))
}

#[derive(Debug)]
enum HtmlError {
    NotFound,
    TemplateError(minijinja::Error),
    SqlxError(sqlx::Error),
    Anyhow(anyhow::Error),
}

impl From<sqlx::Error> for HtmlError {
    fn from(err: sqlx::Error) -> Self {
        HtmlError::SqlxError(err)
    }
}

impl From<minijinja::Error> for HtmlError {
    fn from(err: minijinja::Error) -> Self {
        HtmlError::TemplateError(err)
    }
}

impl From<anyhow::Error> for HtmlError {
    fn from(err: anyhow::Error) -> Self {
        HtmlError::Anyhow(err)
    }
}

impl IntoResponse for HtmlError {
    fn into_response(self) -> Response {
        match self {
            HtmlError::NotFound => (StatusCode::NOT_FOUND, Html(PAGE_404)).into_response(),
            HtmlError::TemplateError(err) => {
                error!("template error: {:?}", err);
                (StatusCode::INTERNAL_SERVER_ERROR, Html(PAGE_500)).into_response()
            }
            HtmlError::SqlxError(err) => {
                error!("sqlx error: {:?}", err);
                (StatusCode::INTERNAL_SERVER_ERROR, Html(PAGE_500)).into_response()
            }
            HtmlError::Anyhow(err) => {
                error!("generic error: {:?}", err);
                (StatusCode::INTERNAL_SERVER_ERROR, Html(PAGE_500)).into_response()
            }
        }
    }
}

static PAGE_404: &str = include_str!("../../templates/404.html");
static PAGE_500: &str = include_str!("../../templates/500.html");

#[cfg(not(debug_assertions))]
static TEMPLATES_DIR: Dir = include_dir!("$CARGO_MANIFEST_DIR/templates");

#[cfg(debug_assertions)]
fn load_templates(env: &mut Environment) {
    use minijinja::path_loader;
    // In development mode, use the file system to load templates in real-time
    env.set_loader(path_loader("templates"));
}

#[cfg(not(debug_assertions))]
fn load_templates(env: &mut Environment<'_>) {
    // In production mode, load templates from the embedded files using include_dir
    for file in TEMPLATES_DIR.files() {
        // file.path() is the path relative to templates/, e.g., "index.html" or "posts/list.html"
        if let Some(name) = file.path().to_str() {
            // If you want to remove subdirectory prefixes, you can handle it here (e.g., keep only the filename)
            let content =
                std::str::from_utf8(file.contents()).expect("Template is not valid utf-8");
            env.add_template(name, content)
                .unwrap_or_else(|e| panic!("Failed to add template {}: {}", name, e));
        }
    }
}

lazy_static! {
    static ref HEADER_BOLD_PARAGRAPH_PATTERN: Regex =
        Regex::new(r#"<h[1-3][^>]*>(.*?)</h[1-3]>\s*(?:<p[^>]*><strong>(.*?)</strong></p>)?"#)
            .unwrap();
    static ref STRONG_TAG_PATTERN: Regex = Regex::new(r"</?strong>").unwrap();
}

fn extract_header_and_description_from_html(html: &str) -> (Option<String>, Option<String>) {
    if let Some(caps) = HEADER_BOLD_PARAGRAPH_PATTERN.captures(html) {
        let title = caps.get(1).map(|m| m.as_str().to_string());
        let bold_paragraph = caps.get(2).map(|m| m.as_str().to_string());
        (
            title,
            bold_paragraph.map(|s| STRONG_TAG_PATTERN.replace_all(s.as_str(), "").to_string()),
        )
    } else {
        (None, None)
    }
}

fn timestamp_to_local_date(timestamp: i64) -> String {
    let datetime = Local.timestamp_opt(timestamp, 0).unwrap().naive_local();
    datetime.format("%Y-%m-%d").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_header_and_bold_paragraph() {
        let html = r#"
            <h1>Title</h1>
            <p><strong>Description</strong></p>
        "#
        .trim();

        let (title, bold_paragraph) = extract_header_and_description_from_html(html);

        assert_eq!(title, Some("Title".to_string()));
        assert_eq!(bold_paragraph, Some("Description".to_string()));
    }

    #[test]
    fn test_header_and_normal_paragraph() {
        let html = r#"
            <h1>Title</h1>
            <p>Description</p>
            <p>Content</p>
        "#
        .trim();

        let (title, bold_paragraph) = extract_header_and_description_from_html(html);

        assert_eq!(title, Some("Title".to_string()));
        assert_eq!(bold_paragraph, None);
    }

    #[test]
    fn test_header_without_adjacent_bold_paragraph() {
        let html = r#"
            <h1 class="header">Title</h1>
            <p>Content</p>
            <p><strong>Description</strong></p>
        "#
        .trim();

        let (title, bold_paragraph) = extract_header_and_description_from_html(html);

        assert_eq!(title, Some("Title".to_string()));
        assert_eq!(bold_paragraph, None);
    }

    #[test]
    fn test_only_header() {
        let html = r#"
            <h1>Title</h1>
        "#
        .trim();

        let (title, bold_paragraph) = extract_header_and_description_from_html(html);

        assert_eq!(title, Some("Title".to_string()));
        assert_eq!(bold_paragraph, None);
    }

    #[test]
    fn test_only_bold_paragraph() {
        let html = r#"
            <p><strong>Bold Description</strong></p>
        "#
        .trim();

        let (title, bold_paragraph) = extract_header_and_description_from_html(html);

        assert_eq!(title, None);
        assert_eq!(bold_paragraph, None);
    }

    #[test]
    fn test_header_not_at_the_start() {
        let html = r#"
            <p>Content</p>
            <h2>Title</h2>
            <p><strong>Description</strong></p>
        "#
        .trim();

        let (title, bold_paragraph) = extract_header_and_description_from_html(html);

        assert_eq!(title, Some("Title".to_string()));
        assert_eq!(bold_paragraph, Some("Description".to_string()));
    }
}
