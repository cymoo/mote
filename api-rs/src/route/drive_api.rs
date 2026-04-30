use crate::errors::{bad_request, ApiError, ApiResult};
use crate::model::drive::*;
use crate::service::drive_service::DriveError;
use crate::util::extractor::{Json, Path, Query};
use crate::AppState;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::header::{
    CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_TYPE, X_CONTENT_TYPE_OPTIONS,
};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::Router;
use futures::TryStreamExt;
use serde::Serialize;
use std::path::PathBuf;
use tokio_util::io::ReaderStream;

pub fn create_routes() -> Router<AppState> {
    Router::new()
        .route("/list", get(list))
        .route("/breadcrumbs", get(breadcrumbs))
        .route("/trash", get(trash))
        .route("/folder", post(create_folder))
        .route("/rename", post(rename))
        .route("/move", post(move_nodes))
        .route("/delete", post(soft_delete))
        .route("/restore", post(restore))
        .route("/purge", post(purge))
        .route("/download", get(download))
        .route("/preview", get(preview))
        .route("/thumb", get(thumb))
        .route("/download-zip", get(download_zip))
        .route("/upload/init", post(upload_init))
        .route(
            "/upload/{upload_id}",
            get(upload_status).delete(upload_cancel),
        )
        .route("/upload/chunk/{upload_id}/{idx}", put(upload_chunk))
        .route("/upload/complete", post(upload_complete))
        .route("/share", post(create_share))
        .route("/shares", get(list_shares))
        .route("/shares/all", get(list_all_shares))
        .route("/share/revoke", post(revoke_share))
}

// ---------- list / tree ----------

async fn list(
    State(state): State<AppState>,
    Query(q): Query<DriveListQuery>,
) -> ApiResult<Json<Vec<DriveNode>>> {
    let out = state
        .drive
        .list(q.parent_id, q.q.as_deref(), &q.order_by, &q.sort)
        .await?;
    Ok(Json(out))
}

async fn breadcrumbs(
    State(state): State<AppState>,
    Query(q): Query<DriveIdQuery>,
) -> ApiResult<Json<Vec<DriveBreadcrumb>>> {
    Ok(Json(state.drive.breadcrumbs(q.id).await?))
}

async fn trash(State(state): State<AppState>) -> ApiResult<Json<Vec<DriveNode>>> {
    Ok(Json(state.drive.list_trash().await?))
}

// ---------- mutations ----------

async fn create_folder(
    State(state): State<AppState>,
    Json(req): Json<DriveCreateFolderRequest>,
) -> ApiResult<Json<DriveNode>> {
    let n = state
        .drive
        .create_folder(req.parent_id, &req.name)
        .await?;
    Ok(Json(n))
}

async fn rename(
    State(state): State<AppState>,
    Json(req): Json<DriveRenameRequest>,
) -> ApiResult<StatusCode> {
    state.drive.rename(req.id, &req.name).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn move_nodes(
    State(state): State<AppState>,
    Json(req): Json<DriveMoveRequest>,
) -> ApiResult<StatusCode> {
    state.drive.move_nodes(&req.ids, req.new_parent_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn soft_delete(
    State(state): State<AppState>,
    Json(req): Json<DriveIdsRequest>,
) -> ApiResult<StatusCode> {
    state.drive.soft_delete(&req.ids).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn restore(
    State(state): State<AppState>,
    Json(req): Json<DriveRestoreRequest>,
) -> ApiResult<StatusCode> {
    state.drive.restore(req.id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn purge(
    State(state): State<AppState>,
    Json(req): Json<DriveIdsRequest>,
) -> ApiResult<StatusCode> {
    state.drive.purge(&req.ids).await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------- download / preview / thumb / zip ----------

async fn download(
    State(state): State<AppState>,
    Query(q): Query<DriveIdQuery>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    serve_blob(&state, q.id, true, &headers).await
}

async fn preview(
    State(state): State<AppState>,
    Query(q): Query<DriveIdQuery>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    serve_blob(&state, q.id, false, &headers).await
}

async fn thumb(
    State(state): State<AppState>,
    Query(q): Query<DriveIdQuery>,
) -> ApiResult<Response> {
    if q.id <= 0 {
        return Err(bad_request("invalid id"));
    }
    let path = state.drive_thumb.thumbnail(q.id).await?;
    let f = tokio::fs::File::open(&path)
        .await
        .map_err(|_| ApiError::NotFound("not found".into()))?;
    let st = f.metadata().await.map_err(|e| ApiError::ServerError(e.to_string()))?;
    let stream = ReaderStream::new(f);
    let body = Body::from_stream(stream);
    let mut resp = Response::new(body);
    resp.headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("image/jpeg"));
    resp.headers_mut().insert(
        CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=86400"),
    );
    resp.headers_mut().insert(
        CONTENT_LENGTH,
        HeaderValue::from_str(&st.len().to_string()).unwrap(),
    );
    Ok(resp)
}

async fn download_zip(
    State(state): State<AppState>,
    Query(q): Query<DriveIdQuery>,
) -> ApiResult<Response> {
    let node = state.drive.find_by_id(q.id).await?;
    if node.r#type != "folder" || node.deleted_at.is_some() {
        return Err(ApiError::NotFound("not found".into()));
    }
    let (writer, reader) = tokio::io::duplex(64 * 1024);
    let zip_svc = state.drive_zip.clone();
    let id = q.id;
    tokio::spawn(async move {
        if let Err(e) = zip_svc.zip_folder(id, writer).await {
            tracing::error!("zip_folder failed: {:?}", e);
        }
    });
    let stream = ReaderStream::new(reader);
    let body = Body::from_stream(stream);
    let mut resp = Response::new(body);
    let h = resp.headers_mut();
    h.insert(CONTENT_TYPE, HeaderValue::from_static("application/zip"));
    let disp = format!(
        "attachment; filename*=UTF-8''{}.zip",
        urlencoding::encode(&node.name)
    );
    h.insert(
        CONTENT_DISPOSITION,
        HeaderValue::from_str(&disp).unwrap_or(HeaderValue::from_static("attachment")),
    );
    h.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    Ok(resp)
}

pub(crate) async fn serve_blob(
    state: &AppState,
    id: i64,
    force_attachment: bool,
    _headers: &HeaderMap,
) -> ApiResult<Response> {
    if id <= 0 {
        return Err(bad_request("invalid id"));
    }
    let node = state.drive.find_by_id(id).await?;
    if node.r#type != "file" || node.blob_path.is_none() || node.deleted_at.is_some() {
        return Err(ApiError::NotFound("not found".into()));
    }
    let blob = node.blob_path.clone().unwrap();
    let abs = state.drive.blob_abs_path(&blob);
    serve_file(&abs, &node.name, node.mime_type.as_deref(), force_attachment).await
}

pub(crate) async fn serve_file(
    abs: &PathBuf,
    name: &str,
    mime: Option<&str>,
    force_attachment: bool,
) -> ApiResult<Response> {
    let f = tokio::fs::File::open(abs)
        .await
        .map_err(|_| ApiError::NotFound("not found".into()))?;
    let st = f
        .metadata()
        .await
        .map_err(|e| ApiError::ServerError(e.to_string()))?;
    let stream = ReaderStream::new(f);
    let body = Body::from_stream(stream);
    let mut resp = Response::new(body);
    let mt = mime.unwrap_or("application/octet-stream").to_string();
    let ext = std::path::Path::new(name)
        .extension()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let force = force_attachment || must_force_attachment(&mt, &ext);
    let disp = format!(
        "{}; filename*=UTF-8''{}",
        if force { "attachment" } else { "inline" },
        urlencoding::encode(name)
    );
    let h = resp.headers_mut();
    h.insert(
        CONTENT_TYPE,
        HeaderValue::from_str(&mt).unwrap_or(HeaderValue::from_static("application/octet-stream")),
    );
    h.insert(
        CONTENT_DISPOSITION,
        HeaderValue::from_str(&disp).unwrap_or(HeaderValue::from_static("inline")),
    );
    h.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(
        CONTENT_LENGTH,
        HeaderValue::from_str(&st.len().to_string()).unwrap(),
    );
    Ok(resp)
}

pub(crate) fn must_force_attachment(mt: &str, ext: &str) -> bool {
    let mt = mt.to_lowercase();
    let ext = ext.trim_start_matches('.').to_lowercase();
    matches!(
        ext.as_str(),
        "html" | "htm" | "svg" | "xhtml" | "xml" | "js" | "mjs"
    ) || mt.starts_with("text/html")
        || mt.contains("javascript")
        || mt.starts_with("image/svg")
        || mt.is_empty()
        || mt == "application/octet-stream"
}

// ---------- uploads ----------

async fn upload_init(
    State(state): State<AppState>,
    Json(req): Json<DriveUploadInitRequest>,
) -> ApiResult<Json<DriveUploadInitResponse>> {
    let u = state.drive_upload.init(&req).await?;
    Ok(Json(DriveUploadInitResponse {
        upload_id: u.id,
        total_chunks: u.total_chunks,
        chunk_size: u.chunk_size,
        received_chunks: vec![],
    }))
}

async fn upload_status(
    State(state): State<AppState>,
    Path(upload_id): Path<String>,
) -> ApiResult<Json<DriveUploadStatusResponse>> {
    let (u, received) = state.drive_upload.get_status(&upload_id).await?;
    Ok(Json(DriveUploadStatusResponse {
        upload_id: u.id,
        total_chunks: u.total_chunks,
        chunk_size: u.chunk_size,
        size: u.size,
        received_chunks: received,
        status: u.status,
    }))
}

async fn upload_chunk(
    State(state): State<AppState>,
    Path((upload_id, idx)): Path<(String, i64)>,
    request: Request,
) -> ApiResult<StatusCode> {
    let body = request.into_body();
    let stream = body.into_data_stream();
    let reader = tokio_util::io::StreamReader::new(
        stream.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)),
    );
    state
        .drive_upload
        .put_chunk(&upload_id, idx, reader)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn upload_cancel(
    State(state): State<AppState>,
    Path(upload_id): Path<String>,
) -> ApiResult<StatusCode> {
    state.drive_upload.cancel(&upload_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn upload_complete(
    State(state): State<AppState>,
    Json(req): Json<DriveUploadCompleteRequest>,
) -> ApiResult<Json<DriveNode>> {
    let policy = if req.on_collision.is_empty() {
        "ask"
    } else {
        req.on_collision.as_str()
    };
    let n = state.drive_upload.complete(&req.upload_id, policy).await?;
    Ok(Json(n))
}

// ---------- shares ----------

#[derive(Serialize)]
struct ShareDTO {
    id: i64,
    node_id: i64,
    has_password: bool,
    expires_at: Option<i64>,
    created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    token: Option<String>,
}

async fn create_share(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<DriveShareCreateRequest>,
) -> ApiResult<Json<ShareDTO>> {
    let s = state
        .drive_share
        .create(req.node_id, req.password.as_deref(), req.expires_at)
        .await?;
    let url = share_url(&headers, &s.token);
    Ok(Json(ShareDTO {
        id: s.row.id,
        node_id: s.row.node_id,
        has_password: s.has_password,
        expires_at: s.row.expires_at,
        created_at: s.row.created_at,
        url: Some(url),
        token: Some(s.token),
    }))
}

async fn list_shares(
    State(state): State<AppState>,
    Query(q): Query<DriveIdQuery>,
) -> ApiResult<Json<Vec<ShareDTO>>> {
    let rows = state.drive_share.list_by_node(q.id).await?;
    let out = rows
        .into_iter()
        .map(|r| ShareDTO {
            id: r.id,
            node_id: r.node_id,
            has_password: r.password_hash.is_some(),
            expires_at: r.expires_at,
            created_at: r.created_at,
            url: None,
            token: None,
        })
        .collect();
    Ok(Json(out))
}

async fn list_all_shares(
    State(state): State<AppState>,
    Query(q): Query<DriveSharesAllQuery>,
) -> ApiResult<Json<Vec<DriveSharedItemDTO>>> {
    let out = state.drive_share.list_all(q.include_expired).await?;
    Ok(Json(out))
}

async fn revoke_share(
    State(state): State<AppState>,
    Json(req): Json<DriveShareRevokeRequest>,
) -> ApiResult<StatusCode> {
    state.drive_share.revoke(req.share_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

fn share_url(headers: &HeaderMap, token: &str) -> String {
    let scheme = if headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.eq_ignore_ascii_case("https"))
        .unwrap_or(false)
    {
        "https"
    } else {
        "http"
    };
    let host = headers
        .get("x-forwarded-host")
        .and_then(|v| v.to_str().ok())
        .or_else(|| headers.get("host").and_then(|v| v.to_str().ok()))
        .unwrap_or("localhost");
    format!("{}://{}/shared-files/{}", scheme, host, token)
}

impl IntoResponse for DriveError {
    fn into_response(self) -> Response {
        ApiError::from(self).into_response()
    }
}
