use crate::AppState;
use chrono::{Duration, Local, Utc};
use std::error::Error;
use tokio_cron_scheduler::{Job, JobScheduler};
use tracing::info;

pub async fn start_jobs(state: AppState) -> Result<(), Box<dyn Error + Send + Sync>> {
    let s1 = state.clone();
    let clear_deleted_posts = Job::new_async_tz("0 0 3 * * *", Local, move |_uuid, _l| {
        let db = s1.db.pool.clone();

        Box::pin(async move {
            info!("[Daily] Checking the posts to be deleted...");

            let thirty_days_ago = (Utc::now() - Duration::days(30)).timestamp_millis();
            let rv = sqlx::query!("DELETE FROM posts WHERE deleted_at < $1", thirty_days_ago,)
                .execute(&db)
                .await
                .ok();

            if let Some(rv) = rv {
                if rv.rows_affected() > 0 {
                    info!("[Daily] Successfully deleted {} posts", rv.rows_affected());
                }
            }
        })
    })?;

    let s2 = state.clone();
    let purge_uploads = Job::new_async_tz("0 0 * * * *", Local, move |_uuid, _l| {
        let svc = s2.drive_upload.clone();
        Box::pin(async move {
            match svc.purge_expired().await {
                Ok(n) if n > 0 => info!("[Hourly] purged {} expired drive uploads", n),
                Err(e) => tracing::warn!("purge uploads failed: {:?}", e),
                _ => {}
            }
        })
    })?;

    let s3 = state.clone();
    let purge_shares = Job::new_async_tz("0 0 * * * *", Local, move |_uuid, _l| {
        let svc = s3.drive_share.clone();
        Box::pin(async move {
            match svc.purge_expired().await {
                Ok(n) if n > 0 => info!("[Hourly] purged {} expired drive shares", n),
                Err(e) => tracing::warn!("purge shares failed: {:?}", e),
                _ => {}
            }
        })
    })?;

    let s4 = state.clone();
    let purge_drive_trash = Job::new_async_tz("0 30 2 * * *", Local, move |_uuid, _l| {
        let drive = s4.drive.clone();
        let pool = s4.db.pool.clone();
        Box::pin(async move {
            let cutoff = (Utc::now() - Duration::days(30)).timestamp_millis();
            let rows: Result<Vec<(i64,)>, _> = sqlx::query_as(
                "SELECT id FROM drive_nodes WHERE deleted_at IS NOT NULL AND deleted_at < ?
                 AND (parent_id IS NULL OR NOT EXISTS (
                    SELECT 1 FROM drive_nodes p WHERE p.id = drive_nodes.parent_id
                      AND p.deleted_at IS NOT NULL AND p.delete_batch_id = drive_nodes.delete_batch_id
                 ))",
            )
            .bind(cutoff)
            .fetch_all(&pool)
            .await;
            let Ok(rows) = rows else { return };
            let ids: Vec<i64> = rows.into_iter().map(|(i,)| i).collect();
            if ids.is_empty() {
                return;
            }
            if let Err(e) = drive.purge(&ids).await {
                tracing::warn!("purge drive trash failed: {:?}", e);
            } else {
                info!("[Daily] purged {} expired drive trash roots", ids.len());
            }
        })
    })?;

    let sched = JobScheduler::new().await?;
    sched.add(clear_deleted_posts).await?;
    sched.add(purge_uploads).await?;
    sched.add(purge_shares).await?;
    sched.add(purge_drive_trash).await?;
    sched.start().await?;

    Ok(())
}
