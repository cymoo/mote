use crate::errors::{ApiError, ApiResult};
use crate::model::post::{
    CreatePostRequest, CreateResponse, FilterPostRequest, Post, PostRow, UpdatePostRequest,
};
use crate::model::tag::Tag;
use chrono::{DateTime, FixedOffset, Utc};
use regex::Regex;
use sqlx::{query, query_as, QueryBuilder, Sqlite, SqlitePool, Transaction};
use std::collections::{HashMap, HashSet};

impl Post {
    pub async fn find_with_parent(pool: &SqlitePool, id: i64) -> ApiResult<Post> {
        let rows = query_as::<_, PostRow>(
            r#"
WITH target AS (
    SELECT *
    FROM posts
    WHERE id = ? AND deleted_at IS NULL
)
SELECT * FROM target
UNION ALL
SELECT parent.*
FROM posts AS parent
INNER JOIN target ON parent.id = target.parent_id
WHERE parent.deleted_at IS NULL
"#,
        )
        .bind(id)
        .fetch_all(pool)
        .await?;

        if rows.is_empty() {
            return Err(post_not_found());
        }

        let mut post = None;
        let mut parents = HashMap::new();
        for row in rows {
            if row.id == id {
                post = Some(Post::from(row));
            } else {
                parents.insert(row.id, Post::from(row));
            }
        }

        let mut post = post.ok_or(post_not_found())?;
        if let Some(parent_id) = post.row.parent_id {
            post.parent = parents.remove(&parent_id).map(Box::new);
        }
        Ok(post)
    }

    pub async fn find_by_id(pool: &SqlitePool, id: i64) -> ApiResult<Option<PostRow>> {
        Ok(sqlx::query_as!(
            PostRow,
            "SELECT * FROM posts WHERE id = ? AND deleted_at IS NULL",
            id
        )
        .fetch_optional(pool)
        .await?)
    }

    pub async fn find_by_ids(pool: &SqlitePool, ids: &[i64]) -> ApiResult<Vec<Post>> {
        let ids = serde_json::to_string(&ids).unwrap();
        let rows = sqlx::query_as!(
            PostRow,
            r#"
            SELECT *
            FROM posts
            WHERE id IN (SELECT value FROM json_each(?1))
            AND deleted_at IS NULL
            "#,
            ids,
        )
        .fetch_all(pool)
        .await?;

        // Convert rows to Post structs
        let mut posts: Vec<Post> = rows.into_iter().map(Post::from).collect();

        Self::attach_parents(pool, &mut posts).await?;
        Self::attach_tags(pool, &mut posts).await?;

        Ok(posts)
    }

    #[allow(dead_code)]
    pub async fn find_children(pool: &SqlitePool, parent_id: i64) -> ApiResult<Vec<PostRow>> {
        Ok(sqlx::query_as!(
            PostRow,
            "SELECT * FROM posts WHERE parent_id = ? AND deleted_at IS NULL",
            parent_id
        )
        .fetch_all(pool)
        .await?)
    }

    pub async fn get_count(pool: &SqlitePool) -> ApiResult<i64> {
        let result = sqlx::query!(
            r#"
            SELECT COUNT(*) as count
            FROM posts
            WHERE deleted_at IS NULL
            "#
        )
        .fetch_one(pool)
        .await?;

        Ok(result.count)
    }

    pub async fn get_active_days(pool: &SqlitePool) -> ApiResult<i64> {
        let result = sqlx::query!(
            r#"
            SELECT COUNT(DISTINCT date(created_at / 1000, 'unixepoch')) as count
            FROM posts
            WHERE deleted_at IS NULL
            "#
        )
        .fetch_one(pool)
        .await?;

        Ok(result.count)
    }

    /// Get daily post counts within a date range
    pub async fn get_daily_counts(
        pool: &SqlitePool,
        start_date: DateTime<FixedOffset>,
        end_date: DateTime<FixedOffset>,
    ) -> ApiResult<Vec<i64>> {
        let offset_ms = start_date.offset().local_minus_utc() as i64 * 1000;
        let start_ts = start_date.timestamp_millis();
        let end_ts = end_date.timestamp_millis();
        let day_ms = 3600 * 24 * 1000;

        // Query daily counts
        let counts: HashMap<i64, i64> = sqlx::query!(
            r#"
            SELECT (created_at + ?) / ? as local_day, COUNT(*) as count
            FROM posts
            WHERE deleted_at IS NULL
                AND created_at BETWEEN ? AND ?
            GROUP BY local_day
            ORDER BY local_day
            "#,
            offset_ms,
            day_ms,
            start_ts,
            end_ts,
        )
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|row| (row.local_day.unwrap(), row.count))
        .collect();

        // Calculate the start and end of local days
        let days = (end_date.date_naive() - start_date.date_naive()).num_days() + 1;
        let start_day = (start_ts + offset_ms) / day_ms;
        let end_day = start_day + days - 1;

        Ok((start_day..=end_day)
            .map(|day| counts.get(&day).copied().unwrap_or(0))
            .collect())
    }

    pub async fn filter_posts(
        pool: &SqlitePool,
        options: &FilterPostRequest,
        per_page: i64,
    ) -> ApiResult<Vec<Post>> {
        let mut builder = if options.tag.is_some() {
            QueryBuilder::<Sqlite>::new(
                r#"
            SELECT DISTINCT p.* FROM posts p
            INNER JOIN tag_post_assoc tp ON p.id = tp.post_id
            INNER JOIN tags t ON tp.tag_id = t.id
            "#,
            )
        } else {
            QueryBuilder::<Sqlite>::new("SELECT p.* FROM posts p")
        };

        builder.push(" WHERE 1 = 1 ");

        // Tag filter
        if let Some(ref tag) = options.tag {
            builder.push(" AND (t.name = ").push_bind(tag);
            builder
                .push(" OR t.name LIKE ")
                .push_bind(format!("{}/%", tag));
            builder.push(" ) ");
        }

        // Handle deleted filter
        if options.deleted {
            builder.push(" AND p.deleted_at IS NOT NULL ");
        } else {
            builder.push(" AND p.deleted_at IS NULL ");
        }

        // Parent ID filter
        if let Some(parent_id) = options.parent_id {
            builder.push(" AND p.parent_id = ").push_bind(parent_id);
        }

        // Color filter
        if let Some(ref color) = options.color {
            builder.push(" AND p.color = ").push_bind(color.to_string());
        }

        // Date range filters
        if let Some(start_date) = options.start_date {
            builder.push(" AND p.created_at >= ").push_bind(start_date);
        }

        if let Some(end_date) = options.end_date {
            builder.push(" AND p.created_at <= ").push_bind(end_date);
        }

        // Shared filter
        if let Some(shared) = options.shared {
            builder.push(" AND p.shared = ").push_bind(shared);
        }

        // Files filter
        if let Some(has_files) = options.has_files {
            builder.push(if has_files {
                " AND p.files IS NOT NULL "
            } else {
                " AND p.files IS NULL "
            });
        }

        let order_by = format!("p.{}", options.order_by);

        // Cursor based pagination
        if let Some(cursor) = options.cursor {
            builder
                .push(format!(
                    " AND {} {} ",
                    order_by,
                    if options.ascending { ">" } else { "<" }
                ))
                .push_bind(cursor);
        }

        let direction = if options.ascending { "ASC" } else { "DESC" };

        builder.push(format!(" ORDER BY {order_by} {direction} LIMIT {per_page}"));

        // Execute query and process results
        let mut posts = builder
            .build_query_as::<PostRow>()
            .fetch_all(pool)
            .await?
            .into_iter()
            .map(Post::from)
            .collect::<Vec<_>>();

        Self::attach_parents(pool, &mut posts).await?;
        Self::attach_tags(pool, &mut posts).await?;

        Ok(posts)
    }

    pub async fn create(pool: &SqlitePool, post: &CreatePostRequest) -> ApiResult<CreateResponse> {
        let now = Utc::now().timestamp_millis();

        // Start transaction
        let mut tx = pool.begin().await?;

        let files = post
            .files
            .as_ref()
            .map(|files| serde_json::to_value(files).unwrap());
        let color = post.color.as_ref().map(|color| color.to_string());
        let shared = post.shared.unwrap_or(false);

        // Insert the post
        let result = sqlx::query!(
            r#"
        INSERT INTO posts (
            content, files, color, shared,
            parent_id, created_at, updated_at, children_count
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        "#,
            post.content,
            files,
            color,
            shared,
            post.parent_id,
            now,
            now,
            0,
        )
        .execute(&mut *tx)
        .await?;

        let post_id = result.last_insert_rowid();

        // Extract and process hashtags
        let hash_tags = extract_hash_tags(&post.content);
        let mut tags = Vec::new();

        for tag_name in hash_tags {
            let tag = Tag::find_or_create(&mut tx, &tag_name).await?;
            tags.push(tag);
        }
        // Update post-tag associations
        Post::update_post_tag_assoc(&mut tx, post_id, &tags, true).await?;

        // Update children count if parent exists
        if let Some(parent_id) = post.parent_id {
            Post::update_children_count(&mut tx, parent_id, true).await?;
        }

        tx.commit().await?;

        Ok(CreateResponse {
            id: post_id,
            created_at: now,
            updated_at: now,
        })
    }

    pub async fn update(pool: &SqlitePool, post: &UpdatePostRequest) -> ApiResult<()> {
        let now = Utc::now().timestamp_millis();

        let mut builder = QueryBuilder::<Sqlite>::new("UPDATE posts SET ");

        builder.push("updated_at = ").push_bind(now);

        post.content.if_present(|content| {
            builder.push(", ");
            builder.push("content = ").push_bind(content);
        });

        post.shared.if_present(|shared| {
            builder.push(", ");
            builder.push("shared = ").push_bind(shared);
        });

        post.parent_id.if_present(|parent_id| {
            builder.push(", ");
            builder.push("parent_id = ").push_bind(parent_id);
        });

        post.files.if_present(|files| {
            builder.push(", ");
            builder.push("files = ").push_bind(
                files
                    .as_ref()
                    .map(|files| serde_json::to_string(&files).unwrap()),
            );
        });

        post.color.if_present(|color| {
            builder.push(", ");
            builder
                .push("color = ")
                .push_bind(color.as_ref().map(|color| color.to_string()));
        });

        builder.push(" WHERE id = ").push_bind(post.id);

        let mut tx = pool.begin().await?;

        if post.parent_id.is_present() {
            let old_parent_id = query!(
                r#"
                SELECT parent_id FROM posts
                WHERE id = ?
                "#,
                post.id
            )
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(post_not_found())?
            .parent_id;

            let parent_id = *post.parent_id.get();

            match (old_parent_id, parent_id) {
                (Some(old_parent_id), None) => {
                    Post::update_children_count(&mut tx, old_parent_id, false).await?;
                }
                (None, Some(parent_id)) => {
                    Post::update_children_count(&mut tx, parent_id, true).await?;
                }
                _ => {}
            }
        }

        builder.build().execute(&mut *tx).await?;

        if post.content.is_present() {
            // Extract and process hashtags
            let hash_tags = extract_hash_tags(post.content.get());
            let mut tags = Vec::new();

            for tag_name in hash_tags {
                let tag = Tag::find_or_create(&mut tx, &tag_name).await?;
                tags.push(tag);
            }
            // Update post-tag associations
            Post::update_post_tag_assoc(&mut tx, post.id, &tags, false).await?;
        }

        tx.commit().await?;
        Ok(())
    }

    pub async fn delete(pool: &SqlitePool, id: i64) -> ApiResult<()> {
        let mut tx = pool.begin().await?;

        let now = Utc::now().timestamp_millis();
        let post = sqlx::query_as!(
            PostRow,
            r#"
            UPDATE posts
            SET deleted_at = ?
            WHERE id = ? AND deleted_at IS NULL
            RETURNING *
            "#,
            now,
            id
        )
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(post_not_found())?;

        if let Some(parent_id) = post.parent_id {
            Post::update_children_count(&mut tx, parent_id, false).await?;
        }

        tx.commit().await?;
        Ok(())
    }

    pub async fn restore(pool: &SqlitePool, id: i64) -> ApiResult<()> {
        let mut tx = pool.begin().await?;

        let post = query_as!(
            PostRow,
            r#"
            UPDATE posts
            SET deleted_at = NULL
            WHERE id = ? AND deleted_at IS NOT NULL
            RETURNING *
            "#,
            id
        )
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(post_not_found())?;

        if let Some(parent_id) = post.parent_id {
            Post::update_children_count(&mut tx, parent_id, true).await?;
        }

        tx.commit().await?;
        Ok(())
    }

    pub async fn clear(pool: &SqlitePool, id: i64) -> ApiResult<()> {
        sqlx::query!(
            r#"
            DELETE FROM posts
            WHERE id = ? AND deleted_at IS NOT NULL
            "#,
            id
        )
        .execute(pool)
        .await?;

        Ok(())
    }

    pub async fn clear_all(pool: &SqlitePool) -> ApiResult<Vec<i64>> {
        let deleted_ids = sqlx::query!(
            r#"
            DELETE FROM posts
            WHERE deleted_at IS NOT NULL
            RETURNING id
            "#
        )
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|x| x.id)
        .collect();

        Ok(deleted_ids)
    }

    async fn update_post_tag_assoc(
        tx: &mut Transaction<'_, Sqlite>,
        post_id: i64,
        tags: &[Tag],
        is_new_post: bool,
    ) -> ApiResult<()> {
        // Remove old relationships if not a new post
        if !is_new_post {
            sqlx::query!(
                r#"
                DELETE FROM tag_post_assoc
                WHERE post_id = ?
                "#,
                post_id
            )
            .execute(&mut **tx)
            .await?;
        }

        // Insert new relationships
        for tag in tags {
            sqlx::query!(
                r#"
                INSERT INTO tag_post_assoc (post_id, tag_id)
                VALUES (?, ?)
                "#,
                post_id,
                tag.id
            )
            .execute(&mut **tx)
            .await?;
        }

        Ok(())
    }

    async fn update_children_count(
        tx: &mut Transaction<'_, Sqlite>,
        parent_id: i64,
        increment: bool,
    ) -> ApiResult<()> {
        let sql = if increment {
            "UPDATE posts SET children_count = children_count + 1 WHERE id = $1"
        } else {
            "UPDATE posts SET children_count = children_count - 1 WHERE id = $1"
        };

        sqlx::query(sql).bind(parent_id).execute(&mut **tx).await?;

        Ok(())
    }

    async fn attach_tags(pool: &SqlitePool, posts: &mut Vec<Post>) -> ApiResult<()> {
        if posts.is_empty() {
            return Ok(());
        }

        let post_ids: Vec<i64> = posts.iter().map(|post| post.row.id).collect();
        let post_ids = serde_json::to_string(&post_ids).unwrap();

        let rows = sqlx::query!(
            r#"
            SELECT tp.post_id, tags.name as "tag_name!"
            FROM tag_post_assoc as tp
            INNER JOIN tags ON tp.tag_id = tags.id
            WHERE tp.post_id IN (SELECT value FROM json_each(?1))
            "#,
            post_ids
        )
        .fetch_all(pool)
        .await?;

        let mut tags: HashMap<i64, Vec<String>> = HashMap::new();
        for row in rows {
            tags.entry(row.post_id).or_default().push(row.tag_name);
        }

        for post in posts {
            post.tags = tags.get(&post.row.id).cloned().unwrap_or_default();
        }

        Ok(())
    }

    async fn attach_parents(pool: &SqlitePool, posts: &mut [Post]) -> ApiResult<()> {
        // Early return if posts is empty
        if posts.is_empty() {
            return Ok(());
        }

        // Collect parent IDs
        let parent_ids: Vec<i64> = posts.iter().filter_map(|post| post.row.parent_id).collect();

        if parent_ids.is_empty() {
            return Ok(());
        }

        let parent_ids = serde_json::to_string(&parent_ids).unwrap();

        // Find all parent posts
        let parent_rows = sqlx::query_as!(
            PostRow,
            r#"
            SELECT *
            FROM posts
            WHERE id IN (SELECT value FROM json_each(?1))
            AND deleted_at IS NULL
            "#,
            parent_ids
        )
        .fetch_all(pool)
        .await?;

        // Create a map of parent posts
        let parents: HashMap<i64, Post> = parent_rows
            .into_iter()
            .map(|row| (row.id, Post::from(row)))
            .collect();

        // Attach parents to posts
        for post in posts.iter_mut() {
            if let Some(parent_id) = post.row.parent_id {
                if let Some(parent) = parents.get(&parent_id) {
                    post.parent = Some(Box::new(parent.clone()));
                }
            }
        }

        Ok(())
    }
}

// Helper functions
fn extract_hash_tags(content: &str) -> HashSet<String> {
    let re = Regex::new(r#"<span class="hash-tag">#(.+?)</span>"#).unwrap();
    re.captures_iter(content)
        .filter_map(|cap| cap.get(1))
        .map(|m| m.as_str().to_string())
        .collect()
}

fn post_not_found() -> ApiError {
    ApiError::NotFound("post not found".to_owned())
}
