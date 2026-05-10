#[cfg(test)]
mod tests {
    use mote::model::tag::Tag;
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::SqlitePool;

    async fn setup() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    async fn create_tag(pool: &SqlitePool, name: &str) -> i64 {
        sqlx::query_scalar(
            r#"
            INSERT INTO tags (name, sticky, created_at, updated_at)
            VALUES (?, false, 1, 1)
            RETURNING id
            "#,
        )
        .bind(name)
        .fetch_one(pool)
        .await
        .unwrap()
    }

    async fn create_post(pool: &SqlitePool, content: &str) -> i64 {
        sqlx::query_scalar(
            r#"
            INSERT INTO posts (content, shared, created_at, updated_at)
            VALUES (?, false, 1, 1)
            RETURNING id
            "#,
        )
        .bind(content)
        .fetch_one(pool)
        .await
        .unwrap()
    }

    async fn associate_tag_post(pool: &SqlitePool, tag_id: i64, post_id: i64) {
        sqlx::query("INSERT INTO tag_post_assoc (tag_id, post_id) VALUES (?, ?)")
            .bind(tag_id)
            .bind(post_id)
            .execute(pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn rename_virtual_parent_with_subtags() {
        let pool = setup().await;
        let source_child_id = create_tag(&pool, "foo1/bar").await;
        let target_id = create_tag(&pool, "foo").await;
        let post1_id = create_post(&pool, "Post about >#foo1/bar<").await;
        let post2_id = create_post(&pool, "Post about >#foo<").await;
        associate_tag_post(&pool, source_child_id, post1_id).await;
        associate_tag_post(&pool, target_id, post2_id).await;

        Tag::rename_or_merge(&pool, "foo1", "foo").await.unwrap();

        let names: Vec<String> = sqlx::query_scalar("SELECT name FROM tags ORDER BY name")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(names, vec!["foo", "foo/bar"]);

        let content: String = sqlx::query_scalar("SELECT content FROM posts WHERE id = ?")
            .bind(post1_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(content, "Post about >#foo/bar<");
    }

    #[tokio::test]
    async fn rename_virtual_parent_creates_target_parent() {
        let pool = setup().await;
        let source_child_id = create_tag(&pool, "foo1/bar").await;
        let post_id = create_post(&pool, "Post about >#foo1/bar<").await;
        associate_tag_post(&pool, source_child_id, post_id).await;

        Tag::rename_or_merge(&pool, "foo1", "foo").await.unwrap();

        let names: Vec<String> = sqlx::query_scalar("SELECT name FROM tags ORDER BY name")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(names, vec!["foo", "foo/bar"]);
    }
}
