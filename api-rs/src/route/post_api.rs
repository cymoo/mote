use crate::config::rd::RedisPool;
use crate::errors::{bad_request, not_found, ApiError, ApiResult};
use crate::middleware::check_access::check_access;
use crate::middleware::limit_request::limit_request;
use crate::model::post::*;
use crate::model::tag::*;
use crate::service::auth_service::AuthService;
use crate::service::upload_service::FileUploadService;
use crate::util::extractor::{Json, ValidatedJson, ValidatedQuery};
use crate::util::fp::Pipe;
use crate::AppState;
use anyhow::Result;
use axum::extract::{Multipart, State};
use axum::http::StatusCode;
use axum::response::Html;
use axum::routing::{get, post};
use axum::{middleware, Router};
use chrono::{DateTime, FixedOffset, NaiveDate, NaiveTime, TimeZone};
use regex::Regex;
use std::borrow::Cow;
use std::collections::HashMap;
use std::future::Future;
use tracing::error;

pub fn create_routes(rd_pool: RedisPool) -> Router<AppState> {
    Router::new()
        .route("/get-tags", get(get_tags))
        .route("/rename-tag", post(rename_tag))
        .route("/stick-tag", post(stick_tag))
        .route("/delete-tag", post(delete_tag))
        .route("/search", get(search_posts))
        .route("/get-posts", get(get_posts))
        .route("/get-post", get(get_post))
        .route("/create-post", post(create_post))
        .route("/update-post", post(update_post))
        .route("/delete-post", post(delete_post))
        .route("/restore-post", post(restore_post))
        .route("/clear-posts", post(clear_posts))
        .route("/get-overall-counts", get(get_stats))
        .route("/get-daily-post-counts", get(get_daily_post_counts))
        .route("/get-stats-summary", get(get_stats_summary))
        .route("/upload", get(file_form).post(upload_file))
        .route(
            "/_dangerously_rebuild_all_indexes",
            get(rebuild_all_indexes),
        )
        .route("/auth", get(|| async {}))
        .route(
            "/login",
            post(login).layer(middleware::from_fn(move |req, next| {
                limit_request(rd_pool.clone(), 60, 5, req, next)
            })),
        )
        .layer(middleware::from_fn(|req, next| {
            check_access(&["/login"], req, next)
        }))
}

async fn login(Json(payload): Json<LoginRequest>) -> ApiResult<StatusCode> {
    if AuthService::is_valid_token(&payload.password) {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::Unauthorized("wrong password".to_string()))
    }
}

async fn get_tags(State(state): State<AppState>) -> ApiResult<Json<Vec<TagWithPostCount>>> {
    let tags = Tag::get_all_with_post_count(&state.db).await?;
    Ok(Json(tags))
}

async fn rename_tag(
    State(state): State<AppState>,
    ValidatedJson(tag): ValidatedJson<RenameTagRequest>,
) -> ApiResult<StatusCode> {
    Tag::rename_or_merge(&state.db, &tag.name, &tag.new_name).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_tag(
    State(state): State<AppState>,
    ValidatedJson(name): ValidatedJson<Name>,
) -> ApiResult<StatusCode> {
    Tag::delete_associated_posts(&state.db, &name.name).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn stick_tag(
    State(state): State<AppState>,
    ValidatedJson(tag): ValidatedJson<StickyTagRequest>,
) -> ApiResult<StatusCode> {
    Tag::insert_or_update(&state.db, &tag.name, tag.sticky).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_posts(
    State(state): State<AppState>,
    ValidatedQuery(query): ValidatedQuery<FilterPostRequest>,
) -> ApiResult<Json<PostPagination>> {
    let posts = Post::filter_posts(&state.db, &query, 30).await?;
    let size = posts.len() as i64;
    let cursor = if size == 0 {
        -1
    } else {
        posts.last().unwrap().row.created_at
    };
    Json(PostPagination {
        posts,
        cursor,
        size,
    })
    .pipe(Ok)
}

async fn get_post(
    State(state): State<AppState>,
    ValidatedQuery(query): ValidatedQuery<Id>,
) -> ApiResult<Json<Post>> {
    let post = Post::find_with_parent(&state.db, query.id).await?;
    Ok(Json(post))
}

async fn search_posts(
    State(state): State<AppState>,
    ValidatedQuery(query): ValidatedQuery<SearchRequest>,
) -> ApiResult<Json<PostPagination>> {
    let (tokens, results) = state
        .fts
        .search(
            query.query.as_str(),
            query.partial.unwrap_or(false),
            query.limit.unwrap_or(0),
        )
        .await?;
    if results.is_empty() {
        return Ok(Json(PostPagination {
            posts: vec![],
            cursor: -1,
            size: 0,
        }));
    }
    let id_to_score: HashMap<i64, f64> = results.into_iter().map(|r| (r.0, r.1)).collect();
    let ids: Vec<i64> = id_to_score.keys().cloned().collect();

    let mut posts = Post::find_by_ids(&state.db, &ids).await?;

    for post in posts.iter_mut() {
        let score = id_to_score[&post.row.id];
        post.row.content = mark_tokens_in_html(&post.row.content, &tokens);
        post.score = Some(score);
    }

    posts.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let size = posts.len() as i64;

    Json(PostPagination {
        posts,
        cursor: -1,
        size,
    })
    .pipe(Ok)
}

async fn create_post(
    State(state): State<AppState>,
    ValidatedJson(post): ValidatedJson<CreatePostRequest>,
) -> ApiResult<Json<CreateResponse>> {
    let content = post.content.clone();
    let res = Post::create(&state.db, &post).await?;

    spawn_background_task("index post", async move {
        state.fts.index(res.id, &content).await
    });
    Ok(Json(res))
}

async fn update_post(
    State(state): State<AppState>,
    ValidatedJson(post): ValidatedJson<UpdatePostRequest>,
) -> ApiResult<StatusCode> {
    let record = Post::find_by_id(&state.db, post.id).await?;

    record
        .filter(|p| p.deleted_at.is_none())
        .ok_or_else(|| not_found("Post not found"))?;

    Post::update(&state.db, &post).await?;

    if post.content.is_present() {
        spawn_background_task("rebuild index", async move {
            state.fts.reindex(post.id, post.content.get()).await
        });
    }

    Ok(StatusCode::NO_CONTENT)
}

async fn delete_post(
    State(state): State<AppState>,
    ValidatedJson(payload): ValidatedJson<DeletePostRequest>,
) -> ApiResult<StatusCode> {
    if payload.hard {
        Post::clear(&state.db, payload.id).await?;

        spawn_background_task("delete index", async move {
            state.fts.deindex(payload.id).await
        });
    } else {
        Post::delete(&state.db, payload.id).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn clear_posts(State(state): State<AppState>) -> ApiResult<StatusCode> {
    let ids = Post::clear_all(&state.db).await?;

    spawn_background_task("clear post indexes", async move {
        for id in ids {
            state.fts.deindex(id).await?;
        }
        Ok(())
    });

    Ok(StatusCode::NO_CONTENT)
}

async fn restore_post(
    State(state): State<AppState>,
    ValidatedJson(payload): ValidatedJson<Id>,
) -> ApiResult<StatusCode> {
    Post::restore(&state.db, payload.id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_stats(State(state): State<AppState>) -> ApiResult<Json<PostStats>> {
    Json(PostStats {
        post_count: Post::get_count(&state.db).await?,
        tag_count: Tag::get_count(&state.db).await?,
        day_count: Post::get_active_days(&state.db).await?,
    })
    .pipe(Ok)
}

async fn get_daily_post_counts(
    State(state): State<AppState>,
    ValidatedQuery(query): ValidatedQuery<DateRange>,
) -> ApiResult<Json<Vec<i64>>> {
    Json(
        Post::get_daily_counts(
            &state.db,
            parse_date_with_timezone(&query.start_date, query.offset, false)?,
            parse_date_with_timezone(&query.end_date, query.offset, true)?,
        )
        .await?,
    )
    .pipe(Ok)
}

async fn get_stats_summary(
    State(state): State<AppState>,
    ValidatedQuery(query): ValidatedQuery<StatsRange>,
) -> ApiResult<Json<StatsSummary>> {
    let start_date = query
        .start_date
        .as_ref()
        .map(|date| parse_date_with_timezone(date, query.offset, false))
        .transpose()?;
    let end_date = query
        .end_date
        .as_ref()
        .map(|date| parse_date_with_timezone(date, query.offset, true))
        .transpose()?;

    if start_date.is_some() != end_date.is_some() {
        return Err(bad_request(
            "start_date and end_date must be provided together",
        ));
    }

    Json(Post::get_stats_summary(&state.db, start_date, end_date, query.offset).await?).pipe(Ok)
}

// For quick test
async fn file_form() -> Html<&'static str> {
    Html(
        r#"
        <!doctype html>
        <html>
            <head><title>Upload file</title></head>
            <body>
                <form action="upload" method="post" enctype="multipart/form-data">
                    <input type="file" name="file" multiple>
                    <button type="submit">Upload</button>
                </form>
            </body>
        </html>
        "#,
    )
}

async fn upload_file(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> ApiResult<Json<FileInfo>> {
    if let Some(field) = multipart.next_field().await? {
        let upload_service = FileUploadService::new(state.config.upload.clone());
        let rv = upload_service.stream_to_file(field).await?;
        Ok(Json(rv))
    } else {
        Err(ApiError::BadRequest("Invalid Multipart".into()))?
    }
}

async fn rebuild_all_indexes(State(state): State<AppState>) -> ApiResult<&'static str> {
    let posts = sqlx::query!("SELECT id, content FROM posts")
        .fetch_all(&state.db.pool)
        .await?;

    spawn_background_task("rebuild all indexes", async move {
        state.fts.clear_all_indexes().await?;

        for post in posts {
            state.fts.index(post.id, &post.content).await?;
        }
        Ok(())
    });

    Ok("Indexing...")
}

fn spawn_background_task<F>(name: &'static str, task: F)
where
    F: Future<Output = Result<()>> + Send + 'static,
{
    let handle = tokio::spawn(task);
    tokio::spawn(async move {
        match handle.await {
            Ok(Ok(())) => {}
            Ok(Err(err)) => error!("Background task '{name}' failed: {err:?}"),
            Err(err) => error!("Background task '{name}' panicked or was cancelled: {err}"),
        }
    });
}

// Helper functions

/// Convert a date string to a DateTime object with timezone information
///
/// # Arguments
///
/// * `date_str` - The date string in "yyyy-MM-dd" format
/// * `utc_offset` - Timezone offset in minutes
/// * `end_of_day` - Whether to use the end time of the day (defaults to false, which means the start time of the day)
///
/// # Errors
///
/// Returns an error if:
/// * The timezone offset is out of range (-1440 to 1440 minutes)
/// * The date string cannot be parsed
/// * The time components cannot be combined
pub fn parse_date_with_timezone(
    date_str: &str,
    utc_offset: i32,
    end_of_day: bool,
) -> Result<DateTime<FixedOffset>> {
    // Validate timezone offset
    if utc_offset.abs() > 1440 {
        return Err(anyhow::anyhow!(
            "Timezone offset must be between -1440 and 1440 minutes: {utc_offset}"
        ));
    }

    // Parse the date string and create time component
    let local_datetime = NaiveDate::parse_from_str(date_str, "%Y-%m-%d")?.and_time(
        if end_of_day {
            NaiveTime::from_hms_milli_opt(23, 59, 59, 999)
        } else {
            NaiveTime::from_hms_opt(0, 0, 0)
        }
        .expect("Invalid time components"),
    );

    // Create timezone offset and convert local time
    FixedOffset::east_opt(utc_offset * 60)
        .ok_or_else(|| anyhow::anyhow!("Invalid timezone offset: {utc_offset}"))?
        .from_local_datetime(&local_datetime)
        .earliest()
        .ok_or_else(|| anyhow::anyhow!("Invalid datetime conversion"))
}

/// Check if a character is Chinese
fn is_chinese_character(c: char) -> bool {
    ('\u{4e00}'..='\u{9fff}').contains(&c)
}

/// Convert a token into a regex pattern, handling word boundaries for Latin text
fn token_to_pattern(token: &str) -> String {
    let escaped = regex::escape(token);
    if token.chars().any(is_chinese_character) {
        escaped
    } else if token
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c.is_ascii_whitespace())
    {
        // Only add word boundaries for pure alphanumeric tokens
        format!(r"\b{}\b", escaped)
    } else {
        // For tokens with special characters, use the escaped version without word boundaries
        escaped
    }
}

/// Mark all occurrences of tokens in HTML text with <mark> tags,
/// avoiding replacements in HTML tags and their attributes.
///
/// # Arguments
/// * `html` - The HTML text to process
/// * `tokens` - List of tokens to be marked
///
/// # Returns
/// The processed HTML text with tokens marked
pub fn mark_tokens_in_html(html: &str, tokens: &[String]) -> String {
    if tokens.is_empty() {
        return html.to_string();
    }

    // Sort tokens by length in descending order
    let mut sorted_tokens = tokens.to_vec();
    sorted_tokens.sort_by_key(|x| std::cmp::Reverse(x.len()));

    // Create the regex pattern
    let patterns: Vec<String> = sorted_tokens
        .iter()
        .map(|token| token_to_pattern(token))
        .collect();

    // Combine patterns with HTML tag pattern
    let pattern = format!(r"(<[^>]*>)|({})", patterns.join("|"));
    let re = Regex::new(&pattern)
        .unwrap_or_else(|_| panic!("Failed to compile regex from: {}", pattern));

    // Process the text
    let result = re.replace_all(html, |caps: &regex::Captures| {
        if caps.get(1).is_some() {
            // HTML tag matched - return unchanged
            // Convert to owned string to avoid lifetime issues
            Cow::Owned(caps[1].to_string())
        } else {
            // Token matched - wrap with mark tags
            Cow::Owned(format!("<mark>{}</mark>", &caps[0]))
        }
    });

    result.into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Timelike;

    #[test]
    fn test_empty_tokens() {
        let text = "<html><body>Hello 世界</body></html>";
        let tokens: Vec<String> = vec![];
        let result = mark_tokens_in_html(text, &tokens);
        assert_eq!(result, text);
    }

    #[test]
    fn test_plain_text() {
        let text = "Hello 世界";
        let tokens = vec!["Hello".to_string(), "世界".to_string()];
        let result = mark_tokens_in_html(text, &tokens);
        assert_eq!(result, "<mark>Hello</mark> <mark>世界</mark>");
    }

    #[test]
    fn test_html_tags() {
        let text = "<html><body>Hello 世界</body></html>";
        let tokens = vec!["body".to_string()];
        let result = mark_tokens_in_html(text, &tokens);
        assert_eq!(result, "<html><body>Hello 世界</body></html>");
    }

    #[test]
    fn test_chinese_characters() {
        let text = "这是一个测试";
        let tokens = vec!["测试".to_string()];
        let result = mark_tokens_in_html(text, &tokens);
        assert_eq!(result, "这是一个<mark>测试</mark>");
    }

    #[test]
    fn test_english_characters() {
        let text = "Hello world, this is a test.";
        let tokens = vec!["test".to_string(), "world".to_string()];
        let result = mark_tokens_in_html(text, &tokens);
        assert_eq!(
            result,
            "Hello <mark>world</mark>, this is a <mark>test</mark>."
        );
    }

    #[test]
    fn test_mixed_content() {
        let text = "<html><body>Hello 世界, this is a 测试.</body></html>";
        let tokens = vec!["Hello".to_string(), "世界".to_string(), "test".to_string()];
        let result = mark_tokens_in_html(text, &tokens);
        assert_eq!(
            result,
            "<html><body><mark>Hello</mark> <mark>世界</mark>, this is a 测试.</body></html>"
        );
    }

    #[test]
    fn test_repeated_tokens() {
        let text = "Hello Hello 世界 世界";
        let tokens = vec!["Hello".to_string(), "世界".to_string()];
        let result = mark_tokens_in_html(text, &tokens);
        assert_eq!(
            result,
            "<mark>Hello</mark> <mark>Hello</mark> <mark>世界</mark> <mark>世界</mark>"
        );
    }

    #[test]
    fn test_special_characters() {
        let text = "This is a test with special characters: *test*.";
        let tokens = vec!["*test*".to_string()];
        let result = mark_tokens_in_html(text, &tokens);
        assert_eq!(
            result,
            "This is a test with special characters: <mark>*test*</mark>."
        );
    }

    #[test]
    fn test_overlapping_tokens() {
        let text = "This is a test with overlapping tokens.";
        let tokens = vec!["test".to_string(), "with overlapping".to_string()];
        let result = mark_tokens_in_html(text, &tokens);
        assert_eq!(
            result,
            "This is a <mark>test</mark> <mark>with overlapping</mark> tokens."
        );
    }

    #[test]
    fn test_start_of_day() {
        let dt = parse_date_with_timezone("2024-01-21", 480, false).unwrap();
        assert_eq!(dt.hour(), 0);
        assert_eq!(dt.minute(), 0);
        assert_eq!(dt.second(), 0);
        assert_eq!(dt.nanosecond(), 0);
        assert_eq!(dt.offset().local_minus_utc(), 480 * 60);
    }

    #[test]
    fn test_end_of_day() {
        let dt = parse_date_with_timezone("2024-01-21", 480, true).unwrap();
        assert_eq!(dt.hour(), 23);
        assert_eq!(dt.minute(), 59);
        assert_eq!(dt.second(), 59);
        assert_eq!(dt.nanosecond(), 999_000_000);
        assert_eq!(dt.offset().local_minus_utc(), 480 * 60);
    }

    #[test]
    fn test_invalid_offset() {
        assert!(parse_date_with_timezone("2024-01-21", 1441, false).is_err());
        assert!(parse_date_with_timezone("2024-01-21", -1441, false).is_err());
    }

    #[test]
    fn test_invalid_date() {
        assert!(parse_date_with_timezone("invalid-date", 480, false).is_err());
    }
}
