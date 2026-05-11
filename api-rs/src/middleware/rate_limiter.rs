use crate::errors::ApiError::TooManyRequests;
use crate::errors::ApiResult;
use axum::extract::Request;
use axum::middleware::Next;
use axum::response::Response;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// (count, reset_at)
pub type RateLimitState = Arc<Mutex<HashMap<String, (u64, Instant)>>>;

pub fn new_state() -> RateLimitState {
    Arc::new(Mutex::new(HashMap::new()))
}

/// Middleware function to enforce rate limiting for incoming requests using an in-memory counter.
///
/// # Arguments
/// * `state` - Shared in-memory counter map.
/// * `expires` - The expiration duration for the rate limit window.
/// * `max_count` - The maximum number of requests allowed within the time window.
/// * `req` - The incoming HTTP request.
/// * `next` - The next middleware or handler in the chain.
pub async fn rate_limit(
    state: RateLimitState,
    expires: Duration,
    max_count: u64,
    req: Request,
    next: Next,
) -> ApiResult<Response> {
    let key = format!("rate:{}", req.uri().path());

    let allowed = {
        let mut store = state.lock().expect("rate limit mutex poisoned");
        let now = Instant::now();
        match store.get_mut(&key) {
            Some((count, reset_at)) if now < *reset_at => {
                if *count >= max_count {
                    false
                } else {
                    *count += 1;
                    true
                }
            }
            _ => {
                store.insert(key, (1, now + expires));
                true
            }
        }
    };

    if !allowed {
        return Err(TooManyRequests("Too many attempts, try again later".to_owned()));
    }

    Ok(next.run(req).await)
}
