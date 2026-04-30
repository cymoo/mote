"""Regression tests for path resolution across drive download / preview /
thumb / zip / shared-link endpoints.

Real-world bug: when ``UPLOAD_PATH`` was configured as a *relative* string
(e.g. ``../samples/uploads``), ``send_file`` would resolve it against the
request-time CWD and fail with ``FileNotFoundError`` — surfacing as 500
on ``/api/drive/thumb`` and ``/shared-files/<token>/download``.

The fix:

1. ``Config.validate()`` now promotes ``UPLOAD_PATH`` to an absolute path.
2. The functional tests below shift the process CWD between the upload
   and the request to catch any future regression where a service start
   cached a relative base path.
"""
from __future__ import annotations

import io
import os
import shutil
import tempfile
from contextlib import contextmanager

import pytest
from flask import current_app
from PIL import Image

from app.config import Config


# ---------------------------------------------------------------------------
# Unit: validate() must absolutize UPLOAD_PATH
# ---------------------------------------------------------------------------


def test_config_upload_path_is_absolute_after_validation():
    cfg = Config()
    tmp = tempfile.mkdtemp(prefix='mote-cfg-test-')
    try:
        cfg.UPLOAD_PATH = os.path.relpath(tmp, os.getcwd())
        cfg.validate()
        assert os.path.isabs(cfg.UPLOAD_PATH)
        assert os.path.realpath(cfg.UPLOAD_PATH) == os.path.realpath(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------------------
# Functional: changing CWD between upload and request must not break
#             send_file / os.stat
# ---------------------------------------------------------------------------


@contextmanager
def _chdir(path: str):
    cwd = os.getcwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(cwd)


def _put_blob(drive, name: str, payload: bytes) -> str:
    rel = os.path.join('drive', name)
    abs_p = drive.blob_abs_path(rel)
    os.makedirs(os.path.dirname(abs_p), exist_ok=True)
    with open(abs_p, 'wb') as f:
        f.write(payload)
    return rel


def _png_bytes() -> bytes:
    img = Image.new('RGB', (32, 32), color=(200, 100, 50))
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return buf.getvalue()


@pytest.fixture()
def drive(app, clean_drive):
    with app.app_context():
        yield current_app.drive_service


@pytest.fixture()
def shares(app, clean_drive):
    with app.app_context():
        yield current_app.drive_share_service


def test_download_and_preview_survive_cwd_change(client, app, drive):
    with app.app_context():
        rel = _put_blob(drive, 'hello.txt.bin', b'hello world')
        node = drive.create_file_node(None, 'hello.txt', rel, 'aabbccdd', 11)
        node_id = node.id

    with tempfile.TemporaryDirectory() as other, _chdir(other):
        rv = client.get(f'/api/drive/download?id={node_id}')
        assert rv.status_code == 200
        assert rv.data == b'hello world'

        rv = client.get(f'/api/drive/preview?id={node_id}')
        assert rv.status_code == 200
        assert rv.data == b'hello world'


def test_thumb_survives_cwd_change(client, app, drive):
    with app.app_context():
        rel = _put_blob(drive, 'pic.png.bin', _png_bytes())
        node = drive.create_file_node(None, 'pic.png', rel, 'deadbeef', 1)
        node_id = node.id

    with tempfile.TemporaryDirectory() as other, _chdir(other):
        rv = client.get(f'/api/drive/thumb?id={node_id}')
        assert rv.status_code == 200
        assert rv.mimetype == 'image/jpeg'
        assert len(rv.data) > 0


def test_shared_download_and_preview_survive_cwd_change(
    client, app, drive, shares
):
    with app.app_context():
        rel = _put_blob(drive, 'share.txt.bin', b'shared payload')
        node = drive.create_file_node(None, 'share.txt', rel, 'cafebabe', 14)
        _, token = shares.create(node.id, password=None, expires_at=None)

    with tempfile.TemporaryDirectory() as other, _chdir(other):
        rv = client.get(f'/shared-files/{token}/download')
        assert rv.status_code == 200
        assert rv.data == b'shared payload'

        rv = client.get(f'/shared-files/{token}/preview')
        assert rv.status_code == 200
        assert rv.data == b'shared payload'


def test_download_zip_survives_cwd_change(client, app, drive):
    with app.app_context():
        folder = drive.create_folder(None, 'pkg')
        rel = _put_blob(drive, 'inside.txt.bin', b'inside zip')
        drive.create_file_node(folder.id, 'inside.txt', rel, 'feedface', 10)
        folder_id = folder.id

    with tempfile.TemporaryDirectory() as other, _chdir(other):
        rv = client.get(f'/api/drive/download-zip?id={folder_id}')
        assert rv.status_code == 200
        assert rv.mimetype == 'application/zip'
        assert len(rv.data) > 0
