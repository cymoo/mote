"""Tests for drive share service: create/list/revoke/resolve, password, expiry."""
from __future__ import annotations

import time

import pytest
from flask import current_app

from app.services.drive import DriveNotFound
from app.services.drive_share import ShareExpired, ShareInvalidNode, ShareNotFound


@pytest.fixture()
def shares(app, clean_drive):
    with app.app_context():
        yield current_app.drive_share_service


@pytest.fixture()
def drive(app, clean_drive):
    with app.app_context():
        yield current_app.drive_service


def _make_file(drive, name='hello.txt', parent_id=None):
    import os
    blob_rel = os.path.join('drive', name + '.bin')
    abs_p = drive.blob_abs_path(blob_rel)
    os.makedirs(os.path.dirname(abs_p), exist_ok=True)
    with open(abs_p, 'wb') as f:
        f.write(b'hi')
    return drive.create_file_node(parent_id, name, blob_rel, 'aabbccdd', 2)


def test_share_create_and_resolve(drive, shares):
    n = _make_file(drive)
    row, token = shares.create(n.id, password=None, expires_at=None)
    assert token
    assert row.id > 0

    share, node = shares.resolve(token)
    assert node.id == n.id
    assert share.password_hash is None


def test_share_password_flow(drive, shares):
    n = _make_file(drive)
    row, token = shares.create(n.id, password='s3cret', expires_at=None)
    share, _ = shares.resolve(token)
    assert share.password_hash is not None
    assert shares.verify_password(share, 's3cret') is True
    assert shares.verify_password(share, 'wrong') is False


def test_share_expired(drive, shares):
    n = _make_file(drive)
    past = int(time.time() * 1000) - 1000
    _, token = shares.create(n.id, password=None, expires_at=past)
    with pytest.raises(ShareExpired):
        shares.resolve(token)


def test_share_unknown_token(shares):
    with pytest.raises(ShareNotFound):
        shares.resolve('totallybogustoken000000000000000000000000000')


def test_share_resolve_after_node_deleted(drive, shares):
    n = _make_file(drive)
    _, token = shares.create(n.id, None, None)
    drive.soft_delete([n.id])
    # Mirror api-go: deleted-node share resolves to ShareNotFound, not
    # DriveNotFound, so anonymous viewers can't distinguish "wrong token"
    # from "shared item was removed".
    with pytest.raises(ShareNotFound):
        shares.resolve(token)


def test_list_by_node_and_revoke(drive, shares):
    n = _make_file(drive)
    r1, _ = shares.create(n.id, None, None)
    r2, _ = shares.create(n.id, 'pw', None)

    rows = shares.list_by_node(n.id)
    assert len(rows) == 2

    shares.revoke(r1.id)
    rows = shares.list_by_node(n.id)
    assert len(rows) == 1
    assert rows[0].id == r2.id


def test_list_all(drive, shares):
    n1 = _make_file(drive, 'a.txt')
    n2 = _make_file(drive, 'b.txt')
    shares.create(n1.id, None, None)
    past = int(time.time() * 1000) - 1000
    shares.create(n2.id, None, past)

    active = shares.list_all(include_expired=False)
    assert len(active) == 1
    item = active[0]
    # Frontend contract: name/size/path/parent_id (mirrors api-go ShareWithNode).
    assert item['name'] == 'a.txt'
    assert item['size'] >= 0
    assert item['path'] == ''
    assert item['parent_id'] is None
    assert item['has_password'] is False
    assert {'id', 'node_id', 'created_at', 'expires_at'} <= item.keys()

    everything = shares.list_all(include_expired=True)
    assert len(everything) == 2


def test_list_all_excludes_deleted_nodes(drive, shares):
    """Parity with api-go: shares of soft-deleted files are filtered out."""
    n = _make_file(drive, 'gone.txt')
    shares.create(n.id, None, None)
    drive.soft_delete([n.id])
    assert shares.list_all(include_expired=False) == []
    assert shares.list_all(include_expired=True) == []


def test_list_all_includes_path(drive, shares):
    """Path is the parent folder breadcrumb chain joined by '/'."""
    a = drive.create_folder(None, 'a')
    b = drive.create_folder(a.id, 'b')
    n = _make_file(drive, 'x.txt', parent_id=b.id)
    shares.create(n.id, None, None)
    items = shares.list_all(include_expired=False)
    assert len(items) == 1
    assert items[0]['path'] == 'a/b'
    assert items[0]['parent_id'] == b.id


def test_share_create_rejects_folder(drive, shares):
    """Parity with api-go: folders cannot be shared."""
    folder = drive.create_folder(None, 'docs')
    with pytest.raises(ShareInvalidNode):
        shares.create(folder.id, None, None)
