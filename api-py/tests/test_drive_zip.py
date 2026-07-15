"""Tests for streaming zip download of a folder tree / node selection."""
from __future__ import annotations

import io
import os
import zipfile

import pytest
from flask import current_app

from app.services.drive import DriveNotFound
from app.services.drive_zip import zip_folder_iter, zip_nodes_iter


@pytest.fixture()
def drive(app, clean_drive):
    with app.app_context():
        yield current_app.drive_service


def _file(drive, parent_id, name, content):
    blob_rel = os.path.join('drive', name + '.bin')
    abs_p = drive.blob_abs_path(blob_rel)
    os.makedirs(os.path.dirname(abs_p), exist_ok=True)
    with open(abs_p, 'wb') as f:
        f.write(content)
    return drive.create_file_node(parent_id, name, blob_rel, 'aabbccdd', len(content))


def test_zip_nested_folder(drive):
    root = drive.create_folder(None, 'box')
    sub = drive.create_folder(root.id, 'sub')
    _file(drive, root.id, 'top.txt', b'top')
    _file(drive, sub.id, 'inner.txt', b'inner')

    buf = io.BytesIO()
    for chunk in zip_folder_iter(drive, root.id):
        buf.write(chunk)
    buf.seek(0)

    with zipfile.ZipFile(buf) as zf:
        names = sorted(zf.namelist())
        assert 'top.txt' in names
        assert 'sub/inner.txt' in names
        assert zf.read('top.txt') == b'top'
        assert zf.read('sub/inner.txt') == b'inner'


def test_zip_empty_folder(drive):
    root = drive.create_folder(None, 'empty')
    buf = io.BytesIO()
    for chunk in zip_folder_iter(drive, root.id):
        buf.write(chunk)
    buf.seek(0)
    with zipfile.ZipFile(buf) as zf:
        # Empty folder yields an empty archive (root is stripped).
        assert zf.namelist() == []


def _file_with_blob(drive, parent_id, name, blob_name, content):
    """Like _file but with a caller-chosen blob name, for tests that create
    same-named nodes in different folders.
    """
    blob_rel = os.path.join('drive', blob_name)
    abs_p = drive.blob_abs_path(blob_rel)
    os.makedirs(os.path.dirname(abs_p), exist_ok=True)
    with open(abs_p, 'wb') as f:
        f.write(content)
    return drive.create_file_node(parent_id, name, blob_rel, '', len(content))


def _read_zip_nodes(drive, ids):
    """Collect zip_nodes_iter output into {entry_name: bytes}."""
    buf = io.BytesIO()
    for chunk in zip_nodes_iter(drive, ids):
        buf.write(chunk)
    buf.seek(0)
    out = {}
    with zipfile.ZipFile(buf) as zf:
        for name in zf.namelist():
            out[name] = zf.read(name)
    return out


def test_zip_nodes_mixed_selection(drive):
    """A mixed folder + file selection lands as top-level entries, with the
    folder keeping its own name as the top-level directory.
    """
    folder = drive.create_folder(None, 'photos')
    _file(drive, folder.id, 'a.jpg', b'aaa')
    root_file = _file_with_blob(drive, None, 'notes.txt', 'test_notes.bin', b'nnn')

    got = _read_zip_nodes(drive, [folder.id, root_file.id])
    assert got == {
        'photos/': b'',
        'photos/a.jpg': b'aaa',
        'notes.txt': b'nnn',
    }


def test_zip_nodes_skips_nested_selection(drive):
    """Ids nested under other selected folders are skipped, not doubled."""
    outer = drive.create_folder(None, 'outer')
    inner = drive.create_folder(outer.id, 'inner')
    nested_file = _file_with_blob(drive, inner.id, 'deep.txt', 'test_deep.bin', b'ddd')

    got = _read_zip_nodes(drive, [outer.id, inner.id, nested_file.id])
    assert got == {
        'outer/': b'',
        'outer/inner/': b'',
        'outer/inner/deep.txt': b'ddd',
    }


def test_zip_nodes_duplicate_top_level_suffixed(drive):
    """Same-named top-level picks (possible from search-result selections)
    get suffixed instead of silently dropped.
    """
    f1 = drive.create_folder(None, 'one')
    f2 = drive.create_folder(None, 'two')
    a = _file_with_blob(drive, f1.id, 'dup.txt', 'test_dup_a.bin', b'first')
    b = _file_with_blob(drive, f2.id, 'dup.txt', 'test_dup_b.bin', b'second')

    got = _read_zip_nodes(drive, [a.id, b.id])
    assert got['dup.txt'] == b'first'
    assert got['dup (1).txt'] == b'second'


def test_zip_nodes_all_gone_raises_before_streaming(drive):
    """A fully deleted/unknown selection raises DriveNotFound eagerly —
    before any body bytes exist — so the handler can still send a 404.
    """
    folder = drive.create_folder(None, 'doomed')
    drive.soft_delete([folder.id])
    with pytest.raises(DriveNotFound):
        zip_nodes_iter(drive, [folder.id, 999999])


def test_download_zip_ids_route(client, app, drive):
    """GET /api/drive/download-zip?ids=… multi-select contract."""
    with app.app_context():
        folder = drive.create_folder(None, 'sel')
        _file(drive, folder.id, 'in.txt', b'in')
        lone = _file_with_blob(drive, None, 'lone.txt', 'test_lone.bin', b'lo')
        folder_id, lone_id = folder.id, lone.id

    rv = client.get(f'/api/drive/download-zip?ids={folder_id},{lone_id},abc,')
    assert rv.status_code == 200
    assert rv.mimetype == 'application/zip'
    assert 'mote-drive-' in rv.headers['Content-Disposition']
    with zipfile.ZipFile(io.BytesIO(rv.data)) as zf:
        assert sorted(zf.namelist()) == ['lone.txt', 'sel/', 'sel/in.txt']

    # No valid id at all → 400.
    rv = client.get('/api/drive/download-zip?ids=abc,-1,')
    assert rv.status_code == 400

    # Entire selection missing → 404 (emitted before any body).
    rv = client.get('/api/drive/download-zip?ids=999999')
    assert rv.status_code == 404

    # Legacy single-folder path unchanged.
    rv = client.get(f'/api/drive/download-zip?id={folder_id}')
    assert rv.status_code == 200
    with zipfile.ZipFile(io.BytesIO(rv.data)) as zf:
        assert zf.namelist() == ['in.txt']
