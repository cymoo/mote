use crate::errors::{any_error, ApiError, ApiResult};
use crate::route::drive_api::serve_file;
use crate::util::extractor::{Form, Path};
use crate::AppState;
use axum::extract::State;
use axum::http::header::{HeaderMap, ACCEPT, LOCATION, SET_COOKIE};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json as AxumJson, Router};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::json;
use sha2::Sha256;
use subtle::ConstantTimeEq;

const SHARE_PW_COOKIE_PREFIX: &str = "drive_share_pw_";

pub fn create_routes() -> Router<AppState> {
    Router::new()
        .route("/{token}", get(landing))
        .route("/{token}/auth", post(auth))
        .route("/{token}/download", get(download))
        .route("/{token}/preview", get(preview))
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

async fn landing(
    State(state): State<AppState>,
    Path(token): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let (share, node) = state.drive_share.resolve(&token).await?;
    let has_password = share.password_hash.is_some();
    let authed = password_ok(&headers, &token, share.password_hash.as_deref());
    let wants_json = headers
        .get(ACCEPT)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.contains("application/json"))
        .unwrap_or(false);

    if wants_json {
        let body = json!({
            "name": node.name,
            "size": node.size.unwrap_or(0),
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
    let mut resp = Response::new(axum::body::Body::empty());
    *resp.status_mut() = StatusCode::SEE_OTHER;
    resp.headers_mut().insert(
        LOCATION,
        HeaderValue::from_str(&format!("/shared-files/{}", token))
            .unwrap_or(HeaderValue::from_static("/")),
    );
    if let Ok(v) = HeaderValue::from_str(&cookie) {
        resp.headers_mut().insert(SET_COOKIE, v);
    }
    Ok(resp)
}

async fn download(
    State(state): State<AppState>,
    Path(token): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    serve_shared(state, token, headers, true).await
}

async fn preview(
    State(state): State<AppState>,
    Path(token): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    serve_shared(state, token, headers, false).await
}

async fn serve_shared(
    state: AppState,
    token: String,
    headers: HeaderMap,
    force: bool,
) -> ApiResult<Response> {
    let (share, node) = state.drive_share.resolve(&token).await?;
    let has_password = share.password_hash.is_some();
    if has_password && !password_ok(&headers, &token, share.password_hash.as_deref()) {
        let mut resp = Response::new(axum::body::Body::empty());
        *resp.status_mut() = StatusCode::SEE_OTHER;
        resp.headers_mut().insert(
            LOCATION,
            HeaderValue::from_str(&format!("/shared-files/{}", token))
                .unwrap_or(HeaderValue::from_static("/")),
        );
        return Ok(resp);
    }
    let Some(blob) = node.blob_path.clone() else {
        return Err(any_error(404, "Not Found", None));
    };
    let abs = state.drive.blob_abs_path(&blob);
    serve_file(&abs, &node.name, node.mime_type.as_deref(), force).await
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

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
