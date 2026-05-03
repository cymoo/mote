use crate::config::db::DB;
use crate::config::rd::RD;
use crate::config::AppConfig;
use crate::errors::{any_error, ApiError};
use crate::route::{drive_api, drive_share, post_api, post_share};
use crate::service::drive_service::DriveService;
use crate::service::drive_share_service::DriveShareService;
use crate::service::drive_thumb_service::DriveThumbService;
use crate::service::drive_upload_service::DriveUploadService;
use crate::service::drive_zip_service::DriveZipService;
use crate::service::search_service::FullTextSearch;
use axum::extract::DefaultBodyLimit;
use axum::handler::HandlerWithoutStateExt;
use axum::http::Uri;
use axum::response::{IntoResponse, Response};
use axum::Router;
use jieba_rs::Jieba;
use std::fs;
use std::sync::Arc;
use std::time::Duration;
use tower::ServiceBuilder;
use tower_http::catch_panic::CatchPanicLayer;
use tower_http::services::ServeDir;
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;
use tracing::error;

pub mod config;
pub mod errors;
pub mod middleware;
pub mod model;
pub mod route;
pub mod service;
pub mod util;

// Application state shared across handlers
// Cloning AppState is cheap because it uses Arc internally to share resources like DB and Redis connections.
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<AppConfig>,
    pub db: Arc<DB>,
    pub rd: Arc<RD>,
    pub fts: Arc<FullTextSearch>,
    pub drive: Arc<DriveService>,
    pub drive_upload: Arc<DriveUploadService>,
    pub drive_share: Arc<DriveShareService>,
    pub drive_thumb: Arc<DriveThumbService>,
    pub drive_zip: Arc<DriveZipService>,
}

// Application router creation
// Note: The order of layers is important.
pub async fn create_app(state: AppState) -> Router {
    let config = &state.config;

    let static_route = Router::new().nest_service(
        &config.static_url,
        ServeDir::new(config.static_path.clone()).not_found_service(handle_404.into_service()),
    );

    fs::create_dir_all(config.upload.base_path.clone())
        .expect("Failed to create 'uploads' directory");

    let uploads_route = Router::new().nest_service(
        &config.upload.base_url,
        ServeDir::new(config.upload.base_path.clone()).not_found_service(handle_404.into_service()),
    );

    let write_timeout = Duration::from_secs(config.http.write_timeout_secs);

    // The order of the layers is important.
    // https://docs.rs/axum/latest/axum/middleware/index.html#ordering
    let mut app = Router::new()
        .nest(
            "/api",
            // Apply the global write timeout to post/note API routes only;
            // drive_api routes own their timeouts internally (file operations
            // need different deadlines than normal JSON endpoints).
            post_api::create_routes(state.rd.pool.clone())
                .layer(TimeoutLayer::new(write_timeout))
                .merge(
                    Router::new().nest("/drive", drive_api::create_routes(write_timeout)).layer(
                        axum::middleware::from_fn(|req, next| {
                            crate::middleware::check_access::check_access(&[], req, next)
                        }),
                    ),
                ),
        )
        .nest(
            "/shared",
            post_share::create_routes().layer(TimeoutLayer::new(write_timeout)),
        )
        .nest("/shared-files", drive_share::create_routes(write_timeout))
        .merge(static_route)
        .merge(uploads_route)
        .fallback(handle_404)
        .method_not_allowed_fallback(handle_405)
        .layer(
            ServiceBuilder::new()
                .layer(CatchPanicLayer::custom(handle_panic))
                // NOTE: Middleware added with Router::layer will run after routing
                // https://stackoverflow.com/questions/75355826/route-paths-with-or-without-of-trailing-slashes-in-rust-axum
                // https://www.matsimitsu.com/blog/2023-07-30-trailing-slashes-for-axum-routes
                // .layer(NormalizePathLayer::trim_trailing_slash())
                .layer(DefaultBodyLimit::max(config.http.max_body_size as usize))
                .layer(config.http.cors.clone().into_layer()),
        );

    if config.log.log_requests {
        app = app.layer(TraceLayer::new_for_http());
    }
    app.with_state(state)
}

// Application state initialization
// Cloning AppState is cheap because it uses Arc internally to share resources like DB and Redis connections.
impl AppState {
    pub async fn new() -> Self {
        let config = AppConfig::from_env();

        let db = Arc::new(
            DB::new(&config.db.url, config.db.pool_size)
                .await
                .expect("Cannot connect to database"),
        );

        let rd = Arc::new(
            RD::new(&config.redis.url)
                .await
                .expect("Cannot connect to redis server"),
        );

        let fts = Arc::new(FullTextSearch::new(
            rd.clone(),
            Arc::new(Jieba::new()),
            "fts:".to_string(),
        ));

        let drive = DriveService::new(db.pool.clone(), config.upload.clone());
        let drive_upload =
            DriveUploadService::new(db.pool.clone(), drive.clone(), config.upload.clone());
        let drive_share = DriveShareService::new(db.pool.clone(), drive.clone());
        let drive_thumb = DriveThumbService::new(drive.clone());
        let drive_zip = DriveZipService::new(drive.clone());

        AppState {
            config: Arc::new(config),
            db,
            fts,
            rd: rd.clone(),
            drive,
            drive_upload,
            drive_share,
            drive_thumb,
            drive_zip,
        }
    }
}

pub async fn handle_404(_uri: Uri) -> ApiError {
    any_error(404, "Not Found", None)
}

async fn handle_405() -> ApiError {
    any_error(405, "Method Not Allowed", None)
}

// Custom panic handler, logs the panic and returns a 500 response
fn handle_panic(panic: Box<dyn std::any::Any + Send>) -> Response {
    let panic_message = if let Some(s) = panic.downcast_ref::<&str>() {
        *s
    } else if let Some(s) = panic.downcast_ref::<String>() {
        s.as_str()
    } else {
        "Unknown panic"
    };

    error!("App panicked: {}", panic_message);
    any_error(500, "Internal Server Error", None).into_response()
}
