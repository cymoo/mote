"""Public anonymous share endpoints — /shared-files/<token>/*.

Mirrors api-go/internal/handlers/drive_share.go.
"""
from __future__ import annotations

import os
import hashlib
import hmac
from urllib.parse import quote

from flask import (
    Blueprint,
    Response,
    abort,
    current_app,
    make_response,
    redirect,
    render_template_string,
    request,
    send_file,
)

from ..services.drive import (
    DriveError,
    DriveNotFound,
    must_force_attachment,
)
from ..services.drive_share import (
    ShareExpired,
    ShareNotFound,
    share_password_cookie_name,
)


shared_bp = Blueprint('shared_drive', __name__)


_LANDING_HTML = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{ name }} · Mote Drive</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         display:flex; align-items:center; justify-content:center; min-height:100vh;
         background:#fafafa; margin:0; color:#1a1a1a; }
  .card { background:#fff; padding:32px 36px; border-radius:14px; box-shadow:0 4px 24px rgba(0,0,0,.06);
          max-width:420px; width:100%; }
  h1 { font-size:18px; margin:0 0 4px; word-break:break-all; }
  p.size { color:#888; margin:0 0 24px; font-size:13px; }
  a.btn, button { display:inline-block; padding:10px 18px; border-radius:8px; background:#111;
           color:#fff; text-decoration:none; border:0; cursor:pointer; font-size:14px; }
  .actions { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
  .preview { display:block; width:100%; max-height:60vh; margin:0 0 16px; border-radius:10px; background:#000; }
  audio.preview { background:transparent; }
  input[type=password] { width:100%; padding:10px 12px; border:1px solid #ddd; border-radius:8px;
           font-size:14px; box-sizing:border-box; margin-bottom:12px; }
  form { margin-top:8px; }
  .meta { color:#666; font-size:13px; margin-top:18px; }
</style>
</head>
<body>
  <div class="card">
    <h1>{{ name }}</h1>
    <p class="size">{{ size }}</p>
    {% if has_password and not authed %}
      <form method="post" action="/shared-files/{{ token }}/auth">
        <input type="password" name="password" placeholder="Password" autofocus required />
        <button type="submit">Unlock</button>
      </form>
    {% else %}
      {% if mime_type.startswith('video/') %}
        <video class="preview" src="/shared-files/{{ token }}/preview" controls preload="metadata"></video>
      {% elif mime_type.startswith('audio/') %}
        <audio class="preview" src="/shared-files/{{ token }}/preview" controls preload="metadata"></audio>
      {% endif %}
      <div class="actions">
        <a class="btn" href="/shared-files/{{ token }}/download">Download</a>
      </div>
    {% endif %}
    <p class="meta">Shared via Mote Drive</p>
  </div>
</body>
</html>"""


def _human_size(n: int) -> str:
    if n < 1024:
        return f'{n} B'
    units = ['KB', 'MB', 'GB', 'TB']
    v = n / 1024.0
    u = 0
    while v >= 1024 and u < len(units) - 1:
        v /= 1024.0
        u += 1
    return f'{v:.1f} {units[u]}'


def _drive():
    return current_app.drive_service


def _share():
    return current_app.drive_share_service


def _resolve_or_abort(token: str):
    try:
        return _share().resolve(token)
    except (ShareNotFound, DriveNotFound):
        abort(404)
    except ShareExpired:
        abort(410, description='share expired')


def _password_ok(share, token: str) -> bool:
    if share.password_hash is None:
        return True
    cookie = request.cookies.get(share_password_cookie_name(token))
    return bool(cookie) and hmac.compare_digest(
        cookie, _share_password_cookie_value(share, token)
    )


def _share_password_cookie_value(share, token: str) -> str:
    if share.password_hash is None:
        abort(400, description='share has no password')
    return hmac.new(
        share.password_hash.encode(),
        token.encode(),
        hashlib.sha256,
    ).hexdigest()


def _client_ip() -> str:
    fwd = request.headers.get('X-Forwarded-For')
    if fwd:
        return fwd.split(',', 1)[0].strip()
    real = request.headers.get('X-Real-IP')
    if real:
        return real
    return request.remote_addr or ''


def _rate_limit(token: str, ip: str) -> bool:
    """Allow up to 10 attempts per 5 min per (token, ip). Returns True if OK."""
    from ..extension import rd

    if rd is None:
        return True
    try:
        key = f'drive:share:rl:{token}:{ip}'
        pipe = rd.pipeline()
        pipe.incr(key)
        pipe.expire(key, 300)
        rv = pipe.execute()
        return int(rv[0]) <= 10
    except Exception:
        return True


@shared_bp.get('/<token>')
def landing(token: str):
    share, node = _resolve_or_abort(token)
    authed = _password_ok(share, token)
    has_password = share.password_hash is not None

    if 'application/json' in (request.headers.get('Accept') or ''):
        return {
            'name': node.name,
            'size': node.size or 0,
            'mime_type': node.mime_type(),
            'has_password': has_password,
            'authed': authed,
            'expires_at': share.expires_at,
        }

    return render_template_string(
        _LANDING_HTML,
        name=node.name,
        size=_human_size(node.size or 0),
        mime_type=node.mime_type(),
        has_password=has_password,
        authed=authed,
        token=token,
    )


@shared_bp.post('/<token>/auth')
def auth(token: str):
    if not _rate_limit(token, _client_ip()):
        abort(429, description='rate limited')
    share, _ = _resolve_or_abort(token)
    pw = request.form.get('password', '')
    if not _share().verify_password(share, pw):
        abort(401, description='wrong password')
    resp = make_response(redirect(f'/shared-files/{token}', code=303))
    resp.set_cookie(
        share_password_cookie_name(token),
        _share_password_cookie_value(share, token),
        path=f'/shared-files/{token}',
        max_age=60 * 60 * 24,
        httponly=True,
        samesite='Lax',
    )
    return resp


def _serve_share(token: str, force_attachment: bool):
    share, node = _resolve_or_abort(token)
    if share.password_hash is not None and not _password_ok(share, token):
        return redirect(f'/shared-files/{token}', code=303)
    if not node.blob_path:
        abort(404)
    abs_path = _drive().blob_abs_path(node.blob_path)
    if not os.path.exists(abs_path):
        abort(404)

    mt = node.mime_type()
    disp = (
        'attachment'
        if (force_attachment or must_force_attachment(mt, node.ext()))
        else 'inline'
    )
    resp = send_file(abs_path, mimetype=mt, conditional=True)
    resp.headers['Content-Disposition'] = (
        f"{disp}; filename*=UTF-8''{quote(node.name, safe='')}"
    )
    resp.headers['X-Content-Type-Options'] = 'nosniff'
    return resp


@shared_bp.get('/<token>/download')
def download(token: str):
    return _serve_share(token, force_attachment=True)


@shared_bp.get('/<token>/preview')
def preview(token: str):
    return _serve_share(token, force_attachment=False)
