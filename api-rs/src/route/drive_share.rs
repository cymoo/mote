use crate::errors::{any_error, ApiError, ApiResult};
use crate::model::drive::{DriveBreadcrumb, DriveNode, DriveShareRow};
use crate::route::drive_api::{must_force_attachment, serve_drive_file, zip_stream_response};
use crate::service::drive_service::DriveError;
use crate::util::extractor::{Form, Path, Query};
use crate::AppState;
use axum::extract::State;
use axum::http::header::{
    HeaderMap, ACCEPT, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE, LOCATION, SET_COOKIE,
};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json as AxumJson, Router};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::json;
use sha2::Sha256;
use std::fmt::Write as _;
use std::time::Duration;
use subtle::ConstantTimeEq;
use tokio_util::io::ReaderStream;
use tower_http::timeout::TimeoutLayer;

const SHARE_PW_COOKIE_PREFIX: &str = "drive_share_pw_";

pub fn create_routes(write_timeout: Duration) -> Router<AppState> {
    Router::new()
        .route("/{token}", get(landing))
        .route("/{token}/auth", post(auth))
        .route("/{token}/download", get(download))
        .route("/{token}/preview", get(preview))
        .route("/{token}/zip", get(zip))
        .route("/{token}/thumb", get(thumb))
        .layer(TimeoutLayer::new(write_timeout))
}

fn cookie_name(token: &str) -> String {
    let n = std::cmp::min(8, token.len());
    let prefix = &token[..n];
    format!("{}{}", SHARE_PW_COOKIE_PREFIX, prefix.replace('-', "_"))
}

type HmacSha256 = Hmac<Sha256>;

fn cookie_value(token: &str, password_hash: &str) -> String {
    let mut mac =
        HmacSha256::new_from_slice(password_hash.as_bytes()).expect("HMAC accepts any key length");
    mac.update(token.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

fn password_ok(headers: &HeaderMap, token: &str, password_hash: Option<&str>) -> bool {
    let Some(password_hash) = password_hash else {
        return true;
    };
    let name = cookie_name(token);
    let want = cookie_value(token, password_hash);
    let Some(c) = headers.get("cookie").and_then(|v| v.to_str().ok()) else {
        return false;
    };
    for kv in c.split(';') {
        let kv = kv.trim();
        if let Some((k, v)) = kv.split_once('=') {
            if k == name && bool::from(v.as_bytes().ct_eq(want.as_bytes())) {
                return true;
            }
        }
    }
    false
}

fn human_size(n: i64) -> String {
    let n = n as f64;
    const K: f64 = 1024.0;
    if n < K {
        return format!("{} B", n as i64);
    }
    let units = ["KB", "MB", "GB", "TB"];
    let mut v = n / K;
    let mut u = 0;
    while v >= K && u < units.len() - 1 {
        v /= K;
        u += 1;
    }
    format!("{:.1} {}", v, units[u])
}

fn client_ip(headers: &HeaderMap) -> String {
    if let Some(v) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
        return v.split(',').next().unwrap_or("").trim().to_string();
    }
    if let Some(v) = headers.get("x-real-ip").and_then(|v| v.to_str().ok()) {
        return v.to_string();
    }
    String::new()
}

fn wants_json(headers: &HeaderMap) -> bool {
    headers
        .get(ACCEPT)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.contains("application/json"))
        .unwrap_or(false)
}

fn not_found() -> ApiError {
    ApiError::NotFound("not found".into())
}

fn redirect_to_landing(token: &str) -> Response {
    let mut resp = Response::new(axum::body::Body::empty());
    *resp.status_mut() = StatusCode::SEE_OTHER;
    resp.headers_mut().insert(
        LOCATION,
        HeaderValue::from_str(&format!("/shared-files/{}", token))
            .unwrap_or(HeaderValue::from_static("/")),
    );
    resp
}

#[derive(Debug, Deserialize, Default)]
struct ShareDirQuery {
    dir: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct ShareIdQuery {
    id: Option<String>,
}

async fn landing(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Query(q): Query<ShareDirQuery>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let (share, node) = state.drive_share.resolve(&token).await?;
    let has_password = share.password_hash.is_some();
    let authed = password_ok(&headers, &token, share.password_hash.as_deref());

    if node.r#type == "folder" {
        return folder_landing(
            &state,
            &share,
            &node,
            &token,
            authed,
            q.dir.as_deref(),
            &headers,
        )
        .await;
    }

    if wants_json(&headers) {
        let body = json!({
            "name": node.name,
            "size": node.size.unwrap_or(0),
            "type": node.r#type,
            "mime_type": node.mime_type.unwrap_or_default(),
            "has_password": has_password,
            "authed": authed,
            "expires_at": share.expires_at,
        });
        return Ok(AxumJson(body).into_response());
    }

    let mime_type = node
        .mime_type
        .as_deref()
        .unwrap_or("application/octet-stream");
    let html = render_landing(
        &node.name,
        &human_size(node.size.unwrap_or(0)),
        mime_type,
        has_password,
        authed,
        &token,
    );
    Ok(Html(html).into_response())
}

/// Renders the visitor page for a shared folder: a server-side file listing
/// with breadcrumbs scoped to the share root, per-file download/preview links,
/// image thumbnails, and a zip-all button. Navigation inside the share uses
/// ?dir=<id>; every id is validated as an active descendant of the share root
/// (resolve_child).
async fn folder_landing(
    state: &AppState,
    share: &DriveShareRow,
    root: &DriveNode,
    token: &str,
    authed: bool,
    dir: Option<&str>,
    headers: &HeaderMap,
) -> ApiResult<Response> {
    let has_password = share.password_hash.is_some();

    let mut display = root.clone();
    // Only honour ?dir= once unlocked — a locked share reveals nothing but its name.
    if let Some(dir_str) = dir.filter(|s| !s.is_empty()) {
        if authed {
            let dir_id = dir_str.parse::<i64>().unwrap_or(0);
            if dir_id <= 0 {
                return Err(not_found());
            }
            let n = state.drive_share.resolve_child(root.id, dir_id).await?;
            if n.r#type != "folder" {
                return Err(not_found());
            }
            display = n;
        }
    }

    let mut children: Vec<DriveNode> = Vec::new();
    let mut crumbs: Vec<DriveBreadcrumb> = Vec::new();
    if authed {
        children = state
            .drive
            .list(Some(display.id), None, "name", "asc")
            .await?;
        crumbs = state.drive.breadcrumbs(display.id).await?;
        // Scope the chain to the share root — never leak ancestors above it.
        if let Some(i) = crumbs.iter().position(|c| c.id == root.id) {
            crumbs.drain(..i);
        }
    }

    if wants_json(headers) {
        let mut resp = json!({
            "name": root.name,
            "size": 0,
            "type": root.r#type,
            "mime_type": "",
            "has_password": has_password,
            "authed": authed,
            "expires_at": share.expires_at,
        });
        if authed {
            let obj = resp.as_object_mut().expect("resp is an object");
            obj.insert(
                "dir".into(),
                json!({"id": display.id, "name": display.name}),
            );
            obj.insert(
                "breadcrumbs".into(),
                json!(crumbs
                    .iter()
                    .map(|c| json!({"id": c.id, "name": c.name}))
                    .collect::<Vec<_>>()),
            );
            obj.insert(
                "children".into(),
                json!(children
                    .iter()
                    .map(|c| json!({
                        "id": c.id,
                        "name": c.name,
                        "type": c.r#type,
                        "size": c.size.unwrap_or(0),
                        "mime_type": c.mime_type.clone().unwrap_or_default(),
                    }))
                    .collect::<Vec<_>>()),
            );
        }
        return Ok(AxumJson(resp).into_response());
    }

    let dir_id = if display.id != root.id { display.id } else { 0 };
    let html = render_folder_landing(
        &root.name,
        has_password,
        authed,
        token,
        &crumbs,
        &children,
        dir_id,
    );
    Ok(Html(html).into_response())
}

#[derive(Deserialize)]
struct AuthForm {
    password: String,
}

async fn auth(
    State(state): State<AppState>,
    Path(token): Path<String>,
    headers: HeaderMap,
    Form(form): Form<AuthForm>,
) -> ApiResult<Response> {
    let ip = client_ip(&headers);
    let key = format!("drive:share:rl:{}:{}", token, ip);
    if !rate_limit_ok(&state, &key, 300, 10).await {
        return Err(ApiError::TooManyRequests("rate limited".into()));
    }
    let (share, _) = state.drive_share.resolve(&token).await?;
    state.drive_share.verify_password(&share, &form.password)?;
    let cookie_value = share
        .password_hash
        .as_deref()
        .map(|h| cookie_value(&token, h))
        .ok_or_else(|| ApiError::BadRequest("share has no password".into()))?;
    let cookie = format!(
        "{}={}; Path=/shared-files/{}; HttpOnly; SameSite=Lax; Max-Age=86400",
        cookie_name(&token),
        cookie_value,
        token
    );
    let mut resp = redirect_to_landing(&token);
    if let Ok(v) = HeaderValue::from_str(&cookie) {
        resp.headers_mut().insert(SET_COOKIE, v);
    }
    Ok(resp)
}

async fn download(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Query(q): Query<ShareIdQuery>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    serve_shared(state, token, headers, true, q.id).await
}

async fn preview(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Query(q): Query<ShareIdQuery>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    serve_shared(state, token, headers, false, q.id).await
}

async fn serve_shared(
    state: AppState,
    token: String,
    headers: HeaderMap,
    force: bool,
    id_param: Option<String>,
) -> ApiResult<Response> {
    let (share, node) = state.drive_share.resolve(&token).await?;
    let has_password = share.password_hash.is_some();
    if has_password && !password_ok(&headers, &token, share.password_hash.as_deref()) {
        return Ok(redirect_to_landing(&token));
    }
    // Folder shares address their files via ?id= (validated as an active
    // descendant of the share root). A bare folder root has no blob to serve.
    let mut target = node;
    if let Some(id_str) = id_param.as_deref().filter(|s| !s.is_empty()) {
        let id = id_str.parse::<i64>().unwrap_or(0);
        if id <= 0 {
            return Err(not_found());
        }
        target = state.drive_share.resolve_child(target.id, id).await?;
    }
    if target.r#type != "file" || target.blob_path.is_none() {
        return Err(any_error(404, "Not Found", None));
    }
    let blob = target.blob_path.clone().expect("checked above");
    let abs = state.drive.blob_abs_path(&blob);
    // Shares are accessed by third parties — keep HTML as attachment to avoid XSS.
    serve_drive_file(
        &state.drive.config,
        &abs,
        &blob,
        &target.name,
        target.mime_type.as_deref(),
        force,
        false,
        &headers,
    )
    .await
}

/// Streams the shared folder (or a ?dir= subfolder of it) as a zip archive.
async fn zip(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Query(q): Query<ShareDirQuery>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let (share, node) = state.drive_share.resolve(&token).await?;
    let has_password = share.password_hash.is_some();
    if has_password && !password_ok(&headers, &token, share.password_hash.as_deref()) {
        return Ok(redirect_to_landing(&token));
    }
    let mut target = node;
    if let Some(dir_str) = q.dir.as_deref().filter(|s| !s.is_empty()) {
        let dir_id = dir_str.parse::<i64>().unwrap_or(0);
        if dir_id <= 0 {
            return Err(not_found());
        }
        target = state.drive_share.resolve_child(target.id, dir_id).await?;
    }
    if target.r#type != "folder" {
        return Err(not_found());
    }
    let (writer, reader) = tokio::io::duplex(64 * 1024);
    let zip_svc = state.drive_zip.clone();
    let id = target.id;
    tokio::spawn(async move {
        if let Err(e) = zip_svc.zip_folder(id, writer).await {
            tracing::error!("share zip failed: {:?}", e);
        }
    });
    Ok(zip_stream_response(reader, &format!("{}.zip", target.name)))
}

/// Serves an image thumbnail for a file inside a shared folder. Reuses the
/// lazily-generated disk cache from the authenticated thumb endpoint.
async fn thumb(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Query(q): Query<ShareIdQuery>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let (share, node) = state.drive_share.resolve(&token).await?;
    // Plain 401 (not a redirect): the consumer is an <img>, not a navigation.
    if share.password_hash.is_some()
        && !password_ok(&headers, &token, share.password_hash.as_deref())
    {
        return Err(ApiError::Unauthorized("unauthorized".into()));
    }
    let id =
        q.id.as_deref()
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(0);
    if id <= 0 {
        return Err(not_found());
    }
    state.drive_share.resolve_child(node.id, id).await?;
    let path = match state.drive_thumb.thumbnail(id).await {
        Ok(p) => p,
        Err(DriveError::NotFound) | Err(DriveError::NotImage) => return Err(not_found()),
        Err(e) => return Err(e.into()),
    };

    let f = tokio::fs::File::open(&path)
        .await
        .map_err(|_| not_found())?;
    let st = f
        .metadata()
        .await
        .map_err(|e| ApiError::ServerError(e.to_string()))?;
    let body = axum::body::Body::from_stream(ReaderStream::new(f));
    let mut resp = Response::new(body);
    let h = resp.headers_mut();
    h.insert(CONTENT_TYPE, HeaderValue::from_static("image/jpeg"));
    h.insert(
        CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=86400"),
    );
    if let Ok(v) = HeaderValue::from_str(&st.len().to_string()) {
        h.insert(CONTENT_LENGTH, v);
    }
    Ok(resp)
}

async fn rate_limit_ok(state: &AppState, key: &str, expires: u64, max_count: i64) -> bool {
    use redis::AsyncCommands;
    let Ok(mut conn) = state.rd.pool.get().await else {
        return true;
    };
    let count: redis::RedisResult<i64> = conn.incr(key, 1i64).await;
    match count {
        Ok(c) => {
            if c == 1 {
                let _: redis::RedisResult<()> = conn.expire(key, expires as i64).await;
            }
            c <= max_count
        }
        Err(_) => true,
    }
}

fn render_landing(
    name: &str,
    size: &str,
    mime_type: &str,
    has_password: bool,
    authed: bool,
    token: &str,
) -> String {
    let body = if has_password && !authed {
        format!(
            r#"<form method="post" action="/shared-files/{token}/auth">
        <input type="password" name="password" placeholder="Password" autofocus required />
        <button type="submit">Unlock</button>
      </form>"#,
            token = html_escape(token)
        )
    } else {
        let token = html_escape(token);
        let preview = if mime_type.starts_with("video/") {
            format!(
                r#"<video class="preview" src="/shared-files/{token}/preview" controls preload="metadata"></video>"#
            )
        } else if mime_type.starts_with("audio/") {
            format!(
                r#"<audio class="preview" src="/shared-files/{token}/preview" controls preload="metadata"></audio>"#
            )
        } else {
            String::new()
        };
        format!(
            r#"{preview}<div class="actions"><a class="btn" href="/shared-files/{token}/download">Download</a></div>"#
        )
    };
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{name} · Mote Drive</title>
<style>
  body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         display:flex; align-items:center; justify-content:center; min-height:100vh;
         background:#fafafa; margin:0; color:#1a1a1a; }}
  .card {{ background:#fff; padding:32px 36px; border-radius:14px; box-shadow:0 4px 24px rgba(0,0,0,.06);
          max-width:420px; width:100%; }}
  h1 {{ font-size:18px; margin:0 0 4px; word-break:break-all; }}
  p.size {{ color:#888; margin:0 0 24px; font-size:13px; }}
  a.btn, button {{ display:inline-block; padding:10px 18px; border-radius:8px; background:#111;
          color:#fff; text-decoration:none; border:0; cursor:pointer; font-size:14px; }}
  .actions {{ display:flex; flex-wrap:wrap; gap:10px; align-items:center; }}
  .preview {{ display:block; width:100%; max-height:60vh; margin:0 0 16px; border-radius:10px; background:#000; }}
  audio.preview {{ background:transparent; }}
  input[type=password] {{ width:100%; padding:10px 12px; border:1px solid #ddd; border-radius:8px;
          font-size:14px; box-sizing:border-box; margin-bottom:12px; }}
  form {{ margin-top:8px; }}
  .meta {{ color:#666; font-size:13px; margin-top:18px; }}
</style>
</head>
<body>
  <div class="card">
    <h1>{name}</h1>
    <p class="size">{size}</p>
    {body}
    <p class="meta">Shared via Mote Drive</p>
  </div>
</body>
</html>"#,
        name = html_escape(name),
        size = html_escape(size),
        body = body
    )
}

const FOLDER_SVG: &str = r##"<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d99c2b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>"##;
const FILE_SVG: &str = r##"<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#8a8f98" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>"##;
const DOWNLOAD_SVG: &str = r#"<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>"#;

/// Visitor page for shared folders: breadcrumbs scoped to the share root, a
/// child listing with thumbnails for images, and per-file preview/download
/// links. Kept as a plain server-rendered page (no JS) in the same style as
/// the single-file landing above.
fn render_folder_landing(
    root_name: &str,
    has_password: bool,
    authed: bool,
    token: &str,
    crumbs: &[DriveBreadcrumb],
    children: &[DriveNode],
    dir_id: i64,
) -> String {
    let esc_token = html_escape(token);

    let body = if has_password && !authed {
        format!(
            r#"<h1>{name}</h1>
      <p class="size">Folder</p>
      <form method="post" action="/shared-files/{token}/auth">
        <input type="password" name="password" placeholder="Password" autofocus required />
        <button type="submit">Unlock</button>
      </form>"#,
            name = html_escape(root_name),
            token = esc_token,
        )
    } else {
        let mut nav = String::new();
        for (i, c) in crumbs.iter().enumerate() {
            if i > 0 {
                nav.push_str(r#"<span class="sep">/</span>"#);
            }
            let name = html_escape(&c.name);
            if i == crumbs.len() - 1 {
                let _ = write!(nav, r#"<span class="cur">{}</span>"#, name);
            } else if i == 0 {
                let _ = write!(nav, r#"<a href="/shared-files/{}">{}</a>"#, esc_token, name);
            } else {
                let _ = write!(
                    nav,
                    r#"<a href="/shared-files/{}?dir={}">{}</a>"#,
                    esc_token, c.id, name
                );
            }
        }

        let listing = if children.is_empty() {
            r#"<p class="empty">This folder is empty</p>"#.to_string()
        } else {
            let mut rows = String::from("<ul class=\"rows\">\n");
            for c in children {
                let is_folder = c.r#type == "folder";
                let mt = c.mime_type.as_deref().unwrap_or_default();
                let ext = c.ext.as_deref().unwrap_or_default();
                let is_image = !is_folder && mt.starts_with("image/");
                // Anything safe to serve inline opens in a browser tab; the
                // rest links straight to download.
                let can_preview = !is_folder && !must_force_attachment(mt, ext);
                let size = if is_folder {
                    "—".to_string()
                } else {
                    human_size(c.size.unwrap_or(0))
                };
                let name = html_escape(&c.name);

                rows.push_str("<li class=\"row\">\n");
                if is_image {
                    let _ = write!(
                        rows,
                        r#"<img class="thumb" loading="lazy" src="/shared-files/{}/thumb?id={}" onerror="this.style.display='none'" alt="" />"#,
                        esc_token, c.id
                    );
                } else if is_folder {
                    let _ = write!(rows, r#"<span class="glyph">{}</span>"#, FOLDER_SVG);
                } else {
                    let _ = write!(rows, r#"<span class="glyph">{}</span>"#, FILE_SVG);
                }
                rows.push('\n');
                if is_folder {
                    let _ = write!(
                        rows,
                        r#"<a class="name" href="/shared-files/{}?dir={}">{}</a>"#,
                        esc_token, c.id, name
                    );
                } else if can_preview {
                    let _ = write!(
                        rows,
                        r#"<a class="name" href="/shared-files/{}/preview?id={}" target="_blank" rel="noopener">{}</a>"#,
                        esc_token, c.id, name
                    );
                } else {
                    let _ = write!(
                        rows,
                        r#"<a class="name" href="/shared-files/{}/download?id={}">{}</a>"#,
                        esc_token, c.id, name
                    );
                }
                let _ = write!(rows, "\n<span class=\"sz\">{}</span>\n", html_escape(&size));
                if !is_folder {
                    let _ = write!(
                        rows,
                        r#"<a class="dl" href="/shared-files/{}/download?id={}" title="Download">{}</a>"#,
                        esc_token, c.id, DOWNLOAD_SVG
                    );
                    rows.push('\n');
                }
                rows.push_str("</li>\n");
            }
            rows.push_str("</ul>");
            rows
        };

        let zip_query = if dir_id > 0 {
            format!("?dir={}", dir_id)
        } else {
            String::new()
        };
        format!(
            r#"<nav class="crumbs">{nav}</nav>
      {listing}
      <div class="actions">
        <a class="btn" href="/shared-files/{token}/zip{zip_query}">Download all (.zip)</a>
      </div>"#,
            nav = nav,
            listing = listing,
            token = esc_token,
            zip_query = zip_query,
        )
    };

    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title} · Mote Drive</title>
<style>
  body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         display:flex; align-items:flex-start; justify-content:center; min-height:100vh;
         background:#fafafa; margin:0; padding:32px 16px; box-sizing:border-box; color:#1a1a1a; }}
  .card {{ background:#fff; padding:24px 28px; border-radius:14px; box-shadow:0 4px 24px rgba(0,0,0,.06);
          max-width:720px; width:100%; box-sizing:border-box; }}
  h1 {{ font-size:18px; margin:0 0 4px; word-break:break-all; }}
  p.size {{ color:#888; margin:0 0 24px; font-size:13px; }}
  .crumbs {{ font-size:14px; margin:0 0 14px; color:#888; word-break:break-all; }}
  .crumbs a {{ color:#2563eb; text-decoration:none; }}
  .crumbs a:hover {{ text-decoration:underline; }}
  .crumbs .sep {{ margin:0 6px; color:#ccc; }}
  .crumbs .cur {{ color:#1a1a1a; font-weight:500; }}
  ul.rows {{ list-style:none; margin:0 0 20px; padding:0; border-top:1px solid #f0f0f0; }}
  li.row {{ display:flex; align-items:center; gap:12px; padding:9px 4px; border-bottom:1px solid #f0f0f0; }}
  li.row:hover {{ background:#fafafa; }}
  .glyph {{ width:36px; height:36px; display:flex; align-items:center; justify-content:center;
           background:#f5f5f5; border-radius:8px; flex-shrink:0; }}
  img.thumb {{ width:36px; height:36px; object-fit:cover; border-radius:8px; flex-shrink:0; background:#f5f5f5; }}
  a.name {{ flex:1; min-width:0; color:#1a1a1a; text-decoration:none; font-size:14px;
           overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }}
  a.name:hover {{ color:#2563eb; }}
  .sz {{ color:#999; font-size:12px; flex-shrink:0; min-width:64px; text-align:right; }}
  a.dl {{ display:flex; padding:6px; border-radius:6px; color:#666; flex-shrink:0; }}
  a.dl:hover {{ background:#eee; color:#1a1a1a; }}
  .actions {{ display:flex; flex-wrap:wrap; gap:10px; align-items:center; }}
  a.btn, button {{ display:inline-block; padding:10px 18px; border-radius:8px; background:#111;
           color:#fff; text-decoration:none; border:0; cursor:pointer; font-size:14px; }}
  input[type=password] {{ width:100%; padding:10px 12px; border:1px solid #ddd; border-radius:8px;
           font-size:14px; box-sizing:border-box; margin-bottom:12px; }}
  form {{ margin-top:8px; }}
  .empty {{ color:#999; font-size:14px; padding:24px 0; text-align:center; }}
  .meta {{ color:#666; font-size:13px; margin-top:18px; }}
</style>
</head>
<body>
  <div class="card">
    {body}
    <p class="meta">Shared via Mote Drive</p>
  </div>
</body>
</html>"#,
        title = html_escape(root_name),
        body = body,
    )
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
