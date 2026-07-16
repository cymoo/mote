"""Public anonymous share endpoints — /shared-files/<token>/*.

Mirrors api-go/internal/handlers/drive_share.go.
"""
from __future__ import annotations

import hashlib
import hmac
from urllib.parse import quote

from flask import (
    Blueprint,
    Response,
    current_app,
    make_response,
    redirect,
    render_template_string,
    request,
    send_file,
    stream_with_context,
)

from ..exception import APIError
from ..services.drive import (
    DriveNotFound,
    DriveNotImage,
    must_force_attachment,
)
from ..services.drive_share import (
    ShareExpired,
    ShareNotFound,
    share_password_cookie_name,
)
from ..services.drive_thumb import make_thumbnail
from ..services.drive_zip import zip_folder_iter
from .drive_serve import serve_drive_blob


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


# Visitor page for shared folders: breadcrumbs scoped to the share root, a
# child listing with thumbnails for images, and per-file preview/download
# links. Kept as a plain server-rendered page (no JS) in the same style as
# the single-file landing above.
_FOLDER_LANDING_HTML = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{ root_name }} · Mote Drive</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         display:flex; align-items:flex-start; justify-content:center; min-height:100vh;
         background:#fafafa; margin:0; padding:32px 16px; box-sizing:border-box; color:#1a1a1a; }
  .card { background:#fff; padding:24px 28px; border-radius:14px; box-shadow:0 4px 24px rgba(0,0,0,.06);
          max-width:720px; width:100%; box-sizing:border-box; }
  h1 { font-size:18px; margin:0 0 4px; word-break:break-all; }
  p.size { color:#888; margin:0 0 24px; font-size:13px; }
  .crumbs { font-size:14px; margin:0 0 14px; color:#888; word-break:break-all; }
  .crumbs a { color:#2563eb; text-decoration:none; }
  .crumbs a:hover { text-decoration:underline; }
  .crumbs .sep { margin:0 6px; color:#ccc; }
  .crumbs .cur { color:#1a1a1a; font-weight:500; }
  ul.rows { list-style:none; margin:0 0 20px; padding:0; border-top:1px solid #f0f0f0; }
  li.row { display:flex; align-items:center; gap:12px; padding:9px 4px; border-bottom:1px solid #f0f0f0; }
  li.row:hover { background:#fafafa; }
  .glyph { width:36px; height:36px; display:flex; align-items:center; justify-content:center;
           background:#f5f5f5; border-radius:8px; flex-shrink:0; }
  img.thumb { width:36px; height:36px; object-fit:cover; border-radius:8px; flex-shrink:0; background:#f5f5f5; }
  a.name { flex:1; min-width:0; color:#1a1a1a; text-decoration:none; font-size:14px;
           overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  a.name:hover { color:#2563eb; }
  .sz { color:#999; font-size:12px; flex-shrink:0; min-width:64px; text-align:right; }
  a.dl { display:flex; padding:6px; border-radius:6px; color:#666; flex-shrink:0; }
  a.dl:hover { background:#eee; color:#1a1a1a; }
  .actions { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
  a.btn, button { display:inline-block; padding:10px 18px; border-radius:8px; background:#111;
           color:#fff; text-decoration:none; border:0; cursor:pointer; font-size:14px; }
  input[type=password] { width:100%; padding:10px 12px; border:1px solid #ddd; border-radius:8px;
           font-size:14px; box-sizing:border-box; margin-bottom:12px; }
  form { margin-top:8px; }
  .empty { color:#999; font-size:14px; padding:24px 0; text-align:center; }
  .meta { color:#666; font-size:13px; margin-top:18px; }
</style>
</head>
<body>
  <div class="card">
    {% if has_password and not authed %}
      <h1>{{ root_name }}</h1>
      <p class="size">Folder</p>
      <form method="post" action="/shared-files/{{ token }}/auth">
        <input type="password" name="password" placeholder="Password" autofocus required />
        <button type="submit">Unlock</button>
      </form>
    {% else %}
      <nav class="crumbs">{% for c in crumbs %}{% if not loop.first %}<span class="sep">/</span>{% endif %}{% if c.is_last %}<span class="cur">{{ c.name }}</span>{% elif c.is_root %}<a href="/shared-files/{{ token }}">{{ c.name }}</a>{% else %}<a href="/shared-files/{{ token }}?dir={{ c.id }}">{{ c.name }}</a>{% endif %}{% endfor %}</nav>
      {% if children %}
      <ul class="rows">
        {% for c in children %}
        <li class="row">
          {% if c.is_image %}
            <img class="thumb" loading="lazy" src="/shared-files/{{ token }}/thumb?id={{ c.id }}" onerror="this.style.display='none'" alt="" />
          {% elif c.is_folder %}
            <span class="glyph"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d99c2b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></span>
          {% else %}
            <span class="glyph"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#8a8f98" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></span>
          {% endif %}
          {% if c.is_folder %}
            <a class="name" href="/shared-files/{{ token }}?dir={{ c.id }}">{{ c.name }}</a>
          {% elif c.can_preview %}
            <a class="name" href="/shared-files/{{ token }}/preview?id={{ c.id }}" target="_blank" rel="noopener">{{ c.name }}</a>
          {% else %}
            <a class="name" href="/shared-files/{{ token }}/download?id={{ c.id }}">{{ c.name }}</a>
          {% endif %}
          <span class="sz">{{ c.size }}</span>
          {% if not c.is_folder %}
          <a class="dl" href="/shared-files/{{ token }}/download?id={{ c.id }}" title="Download"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></a>
          {% endif %}
        </li>
        {% endfor %}
      </ul>
      {% else %}
      <p class="empty">This folder is empty</p>
      {% endif %}
      <div class="actions">
        <a class="btn" href="/shared-files/{{ token }}/zip{% if dir_id %}?dir={{ dir_id }}{% endif %}">Download all (.zip)</a>
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
        raise APIError(404, 'Not Found')
    except ShareExpired:
        raise APIError(410, 'Gone', 'share expired')


def _resolve_child_or_abort(root_id: int, child_id: int):
    """Descendant-scope a ?id=/?dir= lookup; unknown / out-of-subtree /
    trashed targets all surface as a plain 404.
    """
    try:
        return _share().resolve_child(root_id, child_id)
    except (ShareNotFound, DriveNotFound):
        raise APIError(404, 'Not Found')


def _password_ok(share, token: str) -> bool:
    if share.password_hash is None:
        return True
    cookie = request.cookies.get(share_password_cookie_name(token))
    return bool(cookie) and hmac.compare_digest(
        cookie, _share_password_cookie_value(share, token)
    )


def _share_password_cookie_value(share, token: str) -> str:
    if share.password_hash is None:
        raise APIError(400, 'Bad Request', 'share has no password')
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

    if node.type == 'folder':
        return _folder_landing(share, node, token, authed)

    if 'application/json' in (request.headers.get('Accept') or ''):
        return {
            'name': node.name,
            'size': node.size or 0,
            'type': node.type,
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


def _folder_landing(share, root, token: str, authed: bool):
    """Render the visitor page for a shared folder: a server-side file listing
    with breadcrumbs scoped to the share root, per-file download/preview
    links, image thumbnails, and a zip-all button. Navigation inside the
    share uses ?dir=<id>; every id is validated as an active descendant of
    the share root (resolve_child).
    """
    has_password = share.password_hash is not None

    display = root
    # Only honour ?dir= once unlocked — a locked share reveals nothing but its name.
    dir_str = request.args.get('dir', '')
    if dir_str and authed:
        dir_id = request.args.get('dir', type=int) or 0
        if dir_id <= 0:
            raise APIError(404, 'Not Found')
        n = _resolve_child_or_abort(root.id, dir_id)
        if n.type != 'folder':
            raise APIError(404, 'Not Found')
        display = n

    children = []
    crumbs = []
    if authed:
        children = _drive().list(display.id, None, 'name', 'asc')
        crumbs = _drive().breadcrumbs(display.id)
        # Scope the chain to the share root — never leak ancestors above it.
        for i, bc in enumerate(crumbs):
            if bc['id'] == root.id:
                crumbs = crumbs[i:]
                break

    if 'application/json' in (request.headers.get('Accept') or ''):
        resp = {
            'name': root.name,
            'size': 0,
            'type': root.type,
            'mime_type': '',
            'has_password': has_password,
            'authed': authed,
            'expires_at': share.expires_at,
        }
        if authed:
            resp['dir'] = {'id': display.id, 'name': display.name}
            resp['breadcrumbs'] = [
                {'id': bc['id'], 'name': bc['name']} for bc in crumbs
            ]
            resp['children'] = [
                {
                    'id': c.id,
                    'name': c.name,
                    'type': c.type,
                    'size': c.size or 0,
                    'mime_type': c.mime_type(),
                }
                for c in children
            ]
        return resp

    crumb_vms = [
        {
            'id': bc['id'],
            'name': bc['name'],
            'is_root': i == 0,
            'is_last': i == len(crumbs) - 1,
        }
        for i, bc in enumerate(crumbs)
    ]
    child_vms = []
    for c in children:
        vm = {
            'id': c.id,
            'name': c.name,
            'is_folder': c.type == 'folder',
            'is_image': False,
            'can_preview': False,
            'size': '—',
        }
        if c.type != 'folder':
            vm['size'] = _human_size(c.size or 0)
            mt = c.mime_type()
            vm['is_image'] = mt.startswith('image/')
            # Anything safe to serve inline opens in a browser tab; the rest
            # links straight to download.
            vm['can_preview'] = not must_force_attachment(mt, c.ext())
        child_vms.append(vm)

    return render_template_string(
        _FOLDER_LANDING_HTML,
        root_name=root.name,
        has_password=has_password,
        authed=authed,
        token=token,
        crumbs=crumb_vms,
        children=child_vms,
        dir_id=display.id if display.id != root.id else 0,
    )


@shared_bp.post('/<token>/auth')
def auth(token: str):
    if not _rate_limit(token, _client_ip()):
        raise APIError(429, 'Too Many Requests', 'rate limited')
    share, _ = _resolve_or_abort(token)
    pw = request.form.get('password', '')
    if not _share().verify_password(share, pw):
        raise APIError(401, 'Unauthorized', 'wrong password')
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
    # Folder shares address their files via ?id= (validated as an active
    # descendant of the share root). A bare folder root has no blob to serve.
    target = node
    id_str = request.args.get('id', '')
    if id_str:
        child_id = request.args.get('id', type=int) or 0
        if child_id <= 0:
            raise APIError(404, 'Not Found')
        target = _resolve_child_or_abort(node.id, child_id)
    if target.type != 'file' or not target.blob_path:
        raise APIError(404, 'Not Found')
    abs_path = _drive().blob_abs_path(target.blob_path)
    # Shares are accessed by third parties — keep HTML as attachment to avoid XSS.
    return serve_drive_blob(
        abs_path,
        target.blob_path,
        target.name,
        target.mime_type(),
        force_attachment,
    )


@shared_bp.get('/<token>/download')
def download(token: str):
    return _serve_share(token, force_attachment=True)


@shared_bp.get('/<token>/preview')
def preview(token: str):
    return _serve_share(token, force_attachment=False)


@shared_bp.get('/<token>/zip')
def share_zip(token: str):
    """Stream the shared folder (or a ?dir= subfolder of it) as a zip archive."""
    share, node = _resolve_or_abort(token)
    if share.password_hash is not None and not _password_ok(share, token):
        return redirect(f'/shared-files/{token}', code=303)
    target = node
    dir_str = request.args.get('dir', '')
    if dir_str:
        dir_id = request.args.get('dir', type=int) or 0
        if dir_id <= 0:
            raise APIError(404, 'Not Found')
        target = _resolve_child_or_abort(node.id, dir_id)
    if target.type != 'folder':
        raise APIError(404, 'Not Found')
    gen = zip_folder_iter(_drive(), target.id)
    headers = {
        'Content-Type': 'application/zip',
        'Content-Disposition': (
            f"attachment; filename*=UTF-8''{quote(target.name + '.zip', safe='')}"
        ),
        'X-Content-Type-Options': 'nosniff',
    }
    return Response(stream_with_context(gen), headers=headers)


@shared_bp.get('/<token>/thumb')
def share_thumb(token: str):
    """Serve an image thumbnail for a file inside a shared folder. Reuses the
    lazily-generated disk cache from the authenticated thumb endpoint.
    """
    share, node = _resolve_or_abort(token)
    # Plain 401 (not a redirect): the consumer is an <img>, not a navigation.
    if share.password_hash is not None and not _password_ok(share, token):
        raise APIError(401, 'Unauthorized')
    child_id = request.args.get('id', type=int) or 0
    if child_id <= 0:
        raise APIError(404, 'Not Found')
    _resolve_child_or_abort(node.id, child_id)
    try:
        path = make_thumbnail(_drive(), child_id)
    except (DriveNotFound, DriveNotImage):
        raise APIError(404, 'Not Found')
    resp = send_file(path, mimetype='image/jpeg', conditional=True)
    resp.headers['Cache-Control'] = 'private, max-age=86400'
    return resp
