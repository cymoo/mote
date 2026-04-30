"""HTTP handlers for /api/drive/*. Mirrors api-go/internal/handlers/drive.go.

Service instances are attached to the Flask app in app.py as
`app.drive_service`, `app.drive_upload_service`, `app.drive_share_service`.
"""
from __future__ import annotations

import os
from typing import NoReturn
from urllib.parse import quote

from flask import (
    Blueprint,
    Response,
    abort,
    current_app,
    request,
    send_file,
    stream_with_context,
)

from ..dto import (
    DriveCreateFolderRequest,
    DriveDeleteRequest,
    DriveIdQuery,
    DriveListQuery,
    DriveMoveRequest,
    DrivePurgeRequest,
    DriveRenameRequest,
    DriveRestoreRequest,
    DriveShareCreateRequest,
    DriveShareRevokeRequest,
    DriveSharesAllQuery,
    DriveUploadCompleteRequest,
    DriveUploadInitRequest,
)
from ..exception import APIError
from ..services.drive import (
    DriveCycle,
    DriveError,
    DriveInvalidName,
    DriveInvalidParent,
    DriveNameConflict,
    DriveNotFolder,
    DriveNotFound,
    DriveNotImage,
    must_force_attachment,
)
from ..services.drive_share import ShareExpired, ShareNotFound, ShareUnauthorized
from ..services.drive_thumb import make_thumbnail
from ..services.drive_upload import (
    UploadCollision,
    UploadGone,
    UploadInvalid,
    UploadNotFound,
)
from ..services.drive_zip import zip_folder_iter
from ..middleware import validate

drive_bp = Blueprint('drive', __name__)


# ---------------------------------------------------------------------------
# Error mapping
# ---------------------------------------------------------------------------


def _map_drive_err(err: Exception) -> NoReturn:
    if isinstance(err, (DriveNotFound, UploadNotFound, ShareNotFound)):
        abort(404, description=str(err))
    if isinstance(err, DriveNameConflict):
        raise APIError(409, 'Conflict', str(err))
    if isinstance(
        err,
        (
            DriveCycle,
            DriveNotFolder,
            DriveInvalidName,
            DriveInvalidParent,
            UploadInvalid,
        ),
    ):
        abort(400, description=str(err))
    if isinstance(err, UploadCollision):
        raise APIError(409, 'Conflict', str(err))
    if isinstance(err, UploadGone):
        abort(410, description=str(err))
    if isinstance(err, ShareExpired):
        abort(410, description=str(err))
    if isinstance(err, ShareUnauthorized):
        abort(401, description=str(err))
    raise err


def _drive():
    return current_app.drive_service


def _upload():
    return current_app.drive_upload_service


def _share():
    return current_app.drive_share_service


# ---------------------------------------------------------------------------
# List / breadcrumbs / trash
# ---------------------------------------------------------------------------


@drive_bp.get('/list')
@validate(type='query')
def list_nodes(payload: DriveListQuery):
    try:
        rows = _drive().list(
            payload.parent_id, payload.q, payload.order_by or '', payload.sort or ''
        )
    except DriveError as e:
        _map_drive_err(e)
    return [r.to_dict() for r in rows]


@drive_bp.get('/breadcrumbs')
@validate(type='query')
def breadcrumbs(payload: DriveIdQuery):
    try:
        return _drive().breadcrumbs(payload.id)
    except DriveError as e:
        _map_drive_err(e)


@drive_bp.get('/trash')
def trash():
    return [r.to_dict() for r in _drive().list_trash()]


# ---------------------------------------------------------------------------
# Tree mutations
# ---------------------------------------------------------------------------


@drive_bp.post('/folder')
@validate
def create_folder(payload: DriveCreateFolderRequest):
    try:
        n = _drive().create_folder(payload.parent_id, payload.name)
    except DriveError as e:
        _map_drive_err(e)
    return n.to_dict()


@drive_bp.post('/rename')
@validate
def rename(payload: DriveRenameRequest):
    try:
        _drive().rename(payload.id, payload.name)
    except DriveError as e:
        _map_drive_err(e)
    return '', 204


@drive_bp.post('/move')
@validate
def move(payload: DriveMoveRequest):
    try:
        _drive().move(payload.ids, payload.new_parent_id)
    except DriveError as e:
        _map_drive_err(e)
    return '', 204


@drive_bp.post('/delete')
@validate
def delete(payload: DriveDeleteRequest):
    try:
        _drive().soft_delete(payload.ids)
    except DriveError as e:
        _map_drive_err(e)
    return '', 204


@drive_bp.post('/restore')
@validate
def restore(payload: DriveRestoreRequest):
    try:
        _drive().restore(payload.id)
    except DriveError as e:
        _map_drive_err(e)
    return '', 204


@drive_bp.post('/purge')
@validate
def purge(payload: DrivePurgeRequest):
    try:
        _drive().purge(payload.ids)
    except DriveError as e:
        _map_drive_err(e)
    return '', 204


# ---------------------------------------------------------------------------
# Download / preview / thumb / zip
# ---------------------------------------------------------------------------


def _serve_blob(force_attachment: bool):
    try:
        node_id = int(request.args.get('id', '0'))
    except ValueError:
        abort(400, description='invalid id')
    if node_id <= 0:
        abort(400, description='invalid id')
    try:
        n = _drive().find_by_id(node_id)
    except DriveNotFound:
        abort(404)
    if n.type != 'file' or not n.blob_path or n.deleted_at is not None:
        abort(404)
    abs_path = _drive().blob_abs_path(n.blob_path)
    if not os.path.exists(abs_path):
        abort(404)

    mt = n.mime_type()
    disp = (
        'attachment'
        if (force_attachment or must_force_attachment(mt, n.ext()))
        else 'inline'
    )
    resp = send_file(abs_path, mimetype=mt, conditional=True)
    resp.headers['Content-Disposition'] = (
        f"{disp}; filename*=UTF-8''{quote(n.name, safe='')}"
    )
    resp.headers['X-Content-Type-Options'] = 'nosniff'
    return resp


@drive_bp.get('/download')
def download():
    return _serve_blob(force_attachment=True)


@drive_bp.get('/preview')
def preview():
    return _serve_blob(force_attachment=False)


@drive_bp.get('/thumb')
def thumb():
    try:
        node_id = int(request.args.get('id', '0'))
    except ValueError:
        abort(400, description='invalid id')
    if node_id <= 0:
        abort(400, description='invalid id')
    try:
        path = make_thumbnail(_drive(), node_id)
    except (DriveNotFound, DriveNotImage):
        abort(404)
    resp = send_file(path, mimetype='image/jpeg', conditional=True)
    resp.headers['Cache-Control'] = 'private, max-age=86400'
    return resp


@drive_bp.get('/download-zip')
def download_zip():
    try:
        node_id = int(request.args.get('id', '0'))
    except ValueError:
        abort(400, description='invalid id')
    if node_id <= 0:
        abort(400, description='invalid id')
    try:
        n = _drive().find_by_id(node_id)
    except DriveNotFound:
        abort(404)
    if n.type != 'folder' or n.deleted_at is not None:
        abort(404)
    drive = _drive()
    gen = zip_folder_iter(drive, node_id)
    headers = {
        'Content-Type': 'application/zip',
        'Content-Disposition': (
            f"attachment; filename*=UTF-8''{quote(n.name + '.zip', safe='')}"
        ),
        'X-Content-Type-Options': 'nosniff',
    }
    return Response(stream_with_context(gen), headers=headers)


# ---------------------------------------------------------------------------
# Upload (chunked)
# ---------------------------------------------------------------------------


@drive_bp.post('/upload/init')
@validate
def upload_init(payload: DriveUploadInitRequest):
    try:
        u = _upload().init(
            payload.parent_id, payload.name, payload.size, payload.chunk_size
        )
    except DriveError as e:
        _map_drive_err(e)
    return {
        'upload_id': u.upload_id,
        'total_chunks': u.total_chunks,
        'chunk_size': u.chunk_size,
        'received_chunks': [],
    }


@drive_bp.get('/upload/<upload_id>')
def upload_status(upload_id: str):
    try:
        u = _upload().get(upload_id)
    except DriveError as e:
        _map_drive_err(e)
    return {
        'upload_id': u.upload_id,
        'total_chunks': u.total_chunks,
        'chunk_size': u.chunk_size,
        'size': u.size,
        'received_chunks': u.received_chunks,
        'status': u.status,
    }


@drive_bp.put('/upload/chunk/<upload_id>/<int:idx>')
def upload_chunk(upload_id: str, idx: int):
    data = request.get_data(cache=False, as_text=False)
    try:
        _upload().put_chunk(upload_id, idx, data)
    except DriveError as e:
        _map_drive_err(e)
    return '', 204


@drive_bp.post('/upload/complete')
@validate
def upload_complete(payload: DriveUploadCompleteRequest):
    policy = payload.on_collision or 'ask'
    try:
        n = _upload().complete(payload.upload_id, policy)
    except DriveError as e:
        _map_drive_err(e)
    return n.to_dict()


@drive_bp.delete('/upload/<upload_id>')
def upload_cancel(upload_id: str):
    try:
        _upload().cancel(upload_id)
    except DriveError as e:
        _map_drive_err(e)
    return '', 204


# ---------------------------------------------------------------------------
# Shares
# ---------------------------------------------------------------------------


def _share_url(token: str) -> str:
    scheme = 'https' if (
        request.headers.get('X-Forwarded-Proto', '').lower() == 'https'
        or request.is_secure
    ) else 'http'
    host = request.headers.get('X-Forwarded-Host') or request.host
    return f'{scheme}://{host}/shared-files/{token}'


def _share_to_dict(share, token: str = '') -> dict:
    d = {
        'id': share.id,
        'node_id': share.node_id,
        'has_password': share.password_hash is not None,
        'created_at': share.created_at,
        'expires_at': share.expires_at,
    }
    if token:
        d['token'] = token
        d['url'] = _share_url(token)
    return d


@drive_bp.post('/share')
@validate
def create_share(payload: DriveShareCreateRequest):
    try:
        share, token = _share().create(
            payload.node_id, payload.password, payload.expires_at
        )
    except DriveError as e:
        _map_drive_err(e)
    return _share_to_dict(share, token)


@drive_bp.get('/shares')
@validate(type='query')
def list_shares(payload: DriveIdQuery):
    rows = _share().list_by_node(payload.id)
    return [_share_to_dict(r) for r in rows]


@drive_bp.get('/shares/all')
@validate(type='query')
def list_all_shares(payload: DriveSharesAllQuery):
    return _share().list_all(payload.include_expired)


@drive_bp.post('/share/revoke')
@validate
def revoke_share(payload: DriveShareRevokeRequest):
    try:
        _share().revoke(payload.share_id)
    except DriveError as e:
        _map_drive_err(e)
    return '', 204
