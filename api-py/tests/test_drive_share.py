"""Tests for drive share service: create/list/revoke/resolve, password, expiry."""
from __future__ import annotations

import time

import pytest
from flask import current_app

from app.services.drive import DriveNotFound
from app.services.drive_share import ShareExpired, ShareNotFound


@pytest.fixture()
def shares(app, clean_drive):
    with app.app_context():
        yield current_app.drive_share_service


@pytest.fixture()
def drive(app, clean_drive):
    with app.app_context():
        yield current_app.drive_service


def _make_file(drive, name='hello.txt'):
    import os
    blob_rel = os.path.join('drive', name + '.bin')
    abs_p = drive.blob_abs_path(blob_rel)
    os.makedirs(os.path.dirname(abs_p), exist_ok=True)
    with open(abs_p, 'wb') as f:
        f.write(b'hi')
    return drive.create_file_node(None, name, blob_rel, 'aabbccdd', 2)


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
    with pytest.raises(DriveNotFound):
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

    everything = shares.list_all(include_expired=True)
    assert len(everything) == 2
