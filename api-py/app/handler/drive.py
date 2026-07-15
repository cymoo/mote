"""HTTP handlers for /api/drive/*. Mirrors api-go/internal/handlers/drive.go.

Service instances are attached to the Flask app in app.py as
`app.drive_service`, `app.drive_upload_service`, `app.drive_share_service`.
"""
from __future__ import annotations

from typing import NoReturn
from urllib.parse import quote

from flask import (
    Blueprint,
    Response,
    current_app,
    request,
    send_file,
    stream_with_context,
)

from ..dto import (
    DriveCopyRequest,
    DriveCreateFolderRequest,
    DriveDeleteRequest,
    DriveEnsurePathRequest,
    DriveIdQuery,
    DriveListQuery,
    DriveMoveRequest,
    DrivePurgeRequest,
    DriveRenameRequest,
    DriveRestoreRequest,
    DriveShareCreateRequest,
    DriveShareRevokeRequest,
    DriveSharesAllQuery,
    DriveStarRequest,
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
)
from ..services.drive_share import (
    ShareExpired,
    ShareInvalidNode,
    ShareNotFound,
    ShareUnauthorized,
)
from ..services.drive_thumb import make_thumbnail
from ..services.drive_upload import (
    UploadCollision,
    UploadGone,
    UploadInvalid,
    UploadNotFound,
)
from ..services.drive_zip import zip_folder_iter
from ..middleware import validate
from .drive_serve import serve_drive_blob

drive_bp = Blueprint('drive', __name__)


# ---------------------------------------------------------------------------
# Error mapping
# ---------------------------------------------------------------------------


def _map_drive_err(err: Exception) -> NoReturn:
    if isinstance(err, (DriveNotFound, UploadNotFound, ShareNotFound)):
        raise APIError(404, 'Not Found', str(err))
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
            ShareInvalidNode,
        ),
    ):
        raise APIError(400, 'Bad Request', str(err))
    if isinstance(err, UploadCollision):
        raise APIError(409, 'Conflict', str(err))
    if isinstance(err, UploadGone):
        raise APIError(410, 'Gone', str(err))
    if isinstance(err, ShareExpired):
        raise APIError(410, 'Gone', str(err))
    if isinstance(err, ShareUnauthorized):
        raise APIError(401, 'Unauthorized', str(err))
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


@drive_bp.get('/starred')
def starred():
    return [r.to_dict() for r in _drive().list_starred()]


@drive_bp.get('/usage')
def usage():
    return _drive().usage()


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


@drive_bp.post('/folders/ensure-path')
@validate
def ensure_path(payload: DriveEnsurePathRequest):
    """Get-or-create a nested folder chain (folder uploads use this to mirror
    client directory structure) and return the final folder.
    """
    try:
        n = _drive().ensure_folder_path(payload.parent_id, payload.path)
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


@drive_bp.post('/copy')
@validate
def copy_nodes(payload: DriveCopyRequest):
    try:
        rows = _drive().copy(payload.ids, payload.new_parent_id)
    except DriveError as e:
        _map_drive_err(e)
    return [r.to_dict() for r in rows]


@drive_bp.post('/star')
@validate
def star_nodes(payload: DriveStarRequest):
    try:
        _drive().set_starred(payload.ids, payload.starred)
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


def _serve_blob(node_id: int, force_attachment: bool):
    if node_id <= 0:
        raise APIError(400, 'Bad Request', 'invalid id')
    try:
        n = _drive().find_by_id(node_id)
    except DriveNotFound:
        raise APIError(404, 'Not Found')
    if n.type != 'file' or not n.blob_path or n.deleted_at is not None:
        raise APIError(404, 'Not Found')
    abs_path = _drive().blob_abs_path(n.blob_path)
    return serve_drive_blob(
        abs_path,
        n.blob_path,
        n.name,
        n.mime_type(),
        force_attachment,
        allow_inline_html=not force_attachment,
    )


@drive_bp.get('/download')
@validate(type='query')
def download(payload: DriveIdQuery):
    return _serve_blob(payload.id, force_attachment=True)


@drive_bp.get('/preview')
@validate(type='query')
def preview(payload: DriveIdQuery):
    return _serve_blob(payload.id, force_attachment=False)


@drive_bp.get('/thumb')
@validate(type='query')
def thumb(payload: DriveIdQuery):
    if payload.id <= 0:
        raise APIError(400, 'Bad Request', 'invalid id')
    try:
        path = make_thumbnail(_drive(), payload.id)
    except (DriveNotFound, DriveNotImage):
        raise APIError(404, 'Not Found')
    resp = send_file(path, mimetype='image/jpeg', conditional=True)
    resp.headers['Cache-Control'] = 'private, max-age=86400'
    return resp


@drive_bp.get('/download-zip')
@validate(type='query')
def download_zip(payload: DriveIdQuery):
    if payload.id <= 0:
        raise APIError(400, 'Bad Request', 'invalid id')
    try:
        n = _drive().find_by_id(payload.id)
    except DriveNotFound:
        raise APIError(404, 'Not Found')
    if n.type != 'folder' or n.deleted_at is not None:
        raise APIError(404, 'Not Found')
    drive = _drive()
    gen = zip_folder_iter(drive, payload.id)
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
    rows = _share().list_all(payload.include_expired)
    for row in rows:
        token = row.pop('token', None)
        if token:
            row['url'] = _share_url(token)
    return rows


@drive_bp.post('/share/revoke')
@validate
def revoke_share(payload: DriveShareRevokeRequest):
    try:
        _share().revoke(payload.share_id)
    except DriveError as e:
        _map_drive_err(e)
    return '', 204
