from __future__ import annotations

import os
import posixpath
from urllib.parse import quote

from flask import Response, abort, current_app, send_file

from ..services.drive import must_force_attachment


def _accel_redirect_uri(blob_path: str) -> str | None:
    prefix = str(current_app.config.get('DRIVE_ACCEL_REDIRECT_PREFIX', '')).strip().rstrip('/')
    if not prefix:
        return None
    if not prefix.startswith('/'):
        raise ValueError('invalid acceleration prefix')
    if os.path.isabs(blob_path):
        raise ValueError('absolute blob path')

    clean = posixpath.normpath(blob_path.replace(os.sep, '/'))
    directory, name = posixpath.split(clean)
    if directory != 'drive' or name in ('', '.', '..'):
        raise ValueError('unexpected blob path')
    return f'{prefix}/{quote(name, safe="")}'


def serve_drive_blob(
    abs_path: str,
    blob_path: str,
    name: str,
    mime_type: str | None,
    force_attachment: bool,
):
    mt = mime_type or 'application/octet-stream'
    ext = os.path.splitext(name)[1].lower()
    disp = (
        'attachment'
        if (force_attachment or must_force_attachment(mt, ext))
        else 'inline'
    )

    try:
        accel_uri = _accel_redirect_uri(blob_path)
    except ValueError as exc:
        current_app.logger.warning('drive accel redirect refused blob path %r: %s', blob_path, exc)
        abort(404)

    if not os.path.exists(abs_path) or os.path.isdir(abs_path):
        abort(404)

    if accel_uri:
        resp = Response(status=200)
        resp.headers['X-Accel-Redirect'] = accel_uri
    else:
        resp = send_file(abs_path, mimetype=mt, conditional=True)

    resp.headers['Content-Disposition'] = (
        f"{disp}; filename*=UTF-8''{quote(name, safe='')}"
    )
    resp.headers['X-Content-Type-Options'] = 'nosniff'
    if accel_uri:
        resp.headers['Content-Type'] = mt
    return resp
