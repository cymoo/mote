// There are a couple approaches to take when implementing E2E tests. This
// approach adds tests on /src/tests, this way tests can reference modules
// inside the src folder. Another approach would be to have the tests in a
// /tests folder on the root of the project, to do this and be able to import
// modules from the src folder, modules need to be exported as a lib.
#[cfg(test)]
mod tests;

use mote::service::task_service::start_jobs;
use mote::util::env::load_dotenv;
use mote::{create_app, AppState};
use std::env;
use tokio::net::TcpListener;
use tracing::debug;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{fmt, EnvFilter};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    load_dotenv();

    if env::var("MOTE_PASSWORD").is_err() {
        anyhow::bail!("Environment variable 'MOTE_PASSWORD' is not set");
    }

    tracing_subscriber::registry()
        .with(
            EnvFilter::try_from_default_env()
                .unwrap_or(format!("{}=debug", env!("CARGO_CRATE_NAME")).into()),
        )
        .with(fmt::layer())
        .init();

    let app_state = AppState::new().await?;

    let config = &app_state.config;
    debug!("Config:\n {:#?}", config);

    // This integrates database migrations into the application binary
    // to ensure the database is properly migrated during startup.
    let db = &app_state.db;
    if config.db.auto_migrate {
        debug!("Migrating database...");
        db.migrate().await?;
    }

    let state_clone = app_state.clone();
    tokio::spawn(async move {
        if let Err(e) = start_jobs(state_clone).await {
            tracing::error!("Failed to start background jobs: {}", e);
        }
    });

    let addr = format!("{}:{}", &config.http.ip, &config.http.port);
    let app = create_app(app_state).await?;
    let listener = TcpListener::bind(&addr).await?;
    tracing::info!("Listening on {}", addr);
    axum::serve(listener, app).await?;
    Ok(())
}
