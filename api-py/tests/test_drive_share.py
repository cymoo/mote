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


def test_share_folder_create_and_resolve(drive, shares):
    """Parity with api-go: folders can be shared and resolve to the folder."""
    folder = drive.create_folder(None, 'Pics')
    _, token = shares.create(folder.id, None, None)
    _, node = shares.resolve(token)
    assert node.id == folder.id
    assert node.type == 'folder'


def test_share_resolve_child_scope(drive, shares):
    """resolve_child gates every ?id=/?dir= on the public folder-share
    surface: only the share root itself and its ACTIVE descendants may
    resolve.
    """
    root = drive.create_folder(None, 'root')
    sub = drive.create_folder(root.id, 'sub')
    inner = _make_file(drive, 'in.txt', parent_id=sub.id)
    outside = _make_file(drive, 'out.txt')

    # The root itself resolves.
    assert shares.resolve_child(root.id, root.id).id == root.id
    # An active descendant resolves.
    assert shares.resolve_child(root.id, inner.id).id == inner.id
    # A node outside the share subtree → not found.
    with pytest.raises(ShareNotFound):
        shares.resolve_child(root.id, outside.id)
    # A trashed descendant → not found.
    drive.soft_delete([inner.id])
    with pytest.raises(ShareNotFound):
        shares.resolve_child(root.id, inner.id)
    # A child inside a trashed folder → not found (the deleted hop breaks
    # the chain).
    f2 = drive.create_folder(root.id, 'f2')
    leaf = _make_file(drive, 'leaf.txt', parent_id=f2.id)
    drive.soft_delete([f2.id])
    with pytest.raises(ShareNotFound):
        shares.resolve_child(root.id, leaf.id)


# ---------------------------------------------------------------------------
# Public /shared-files surface for folder shares
# ---------------------------------------------------------------------------


JSON_ACCEPT = {'Accept': 'application/json'}


def _folder_share_fixture(drive, shares, password=None):
    """root/{a.txt, sub/{b.txt}} shared at root. Returns (token, ids)."""
    root = drive.create_folder(None, 'root')
    sub = drive.create_folder(root.id, 'sub')
    a = _make_file(drive, 'a.txt', parent_id=root.id)
    b = _make_file(drive, 'b.txt', parent_id=sub.id)
    outside = _make_file(drive, 'outside.txt')
    _, token = shares.create(root.id, password, None)
    return token, {
        'root': root.id, 'sub': sub.id,
        'a': a.id, 'b': b.id, 'outside': outside.id,
    }


def test_shared_folder_landing_json(client, app, drive, shares):
    with app.app_context():
        token, ids = _folder_share_fixture(drive, shares)

    rv = client.get(f'/shared-files/{token}', headers=JSON_ACCEPT)
    assert rv.status_code == 200
    body = rv.get_json()
    assert body['name'] == 'root'
    assert body['size'] == 0
    assert body['type'] == 'folder'
    assert body['mime_type'] == ''
    assert body['has_password'] is False
    assert body['authed'] is True
    assert body['expires_at'] is None
    assert body['dir'] == {'id': ids['root'], 'name': 'root'}
    assert body['breadcrumbs'] == [{'id': ids['root'], 'name': 'root'}]
    # Folders first, then files (name asc).
    assert [(c['name'], c['type']) for c in body['children']] == [
        ('sub', 'folder'), ('a.txt', 'file'),
    ]
    kid = body['children'][1]
    assert kid.keys() == {'id', 'name', 'type', 'size', 'mime_type'}
    assert kid['size'] == 2
    assert kid['mime_type'] == 'text/plain'

    # ?dir= navigates inside the share subtree.
    rv = client.get(f"/shared-files/{token}?dir={ids['sub']}", headers=JSON_ACCEPT)
    body = rv.get_json()
    assert body['dir'] == {'id': ids['sub'], 'name': 'sub'}
    assert body['breadcrumbs'] == [
        {'id': ids['root'], 'name': 'root'},
        {'id': ids['sub'], 'name': 'sub'},
    ]
    assert [c['name'] for c in body['children']] == ['b.txt']

    # ?dir= outside the share subtree → 404; a file id as dir → 404.
    assert client.get(
        f"/shared-files/{token}?dir={ids['outside']}", headers=JSON_ACCEPT
    ).status_code == 404
    assert client.get(
        f"/shared-files/{token}?dir={ids['a']}", headers=JSON_ACCEPT
    ).status_code == 404


def test_shared_folder_landing_html(client, app, drive, shares):
    with app.app_context():
        token, ids = _folder_share_fixture(drive, shares)

    rv = client.get(f'/shared-files/{token}')
    assert rv.status_code == 200
    html = rv.get_data(as_text=True)
    assert 'root' in html
    assert 'a.txt' in html
    assert 'sub' in html
    assert f'/shared-files/{token}/zip' in html
    assert f"/shared-files/{token}/download?id={ids['a']}" in html


def test_shared_folder_locked_hides_children(client, app, drive, shares):
    with app.app_context():
        token, ids = _folder_share_fixture(drive, shares, password='pw123')

    rv = client.get(f'/shared-files/{token}', headers=JSON_ACCEPT)
    body = rv.get_json()
    assert body['has_password'] is True
    assert body['authed'] is False
    assert 'children' not in body
    assert 'dir' not in body
    assert 'breadcrumbs' not in body

    # The HTML landing shows only the password form — no child names leak.
    html = client.get(f'/shared-files/{token}').get_data(as_text=True)
    assert 'password' in html
    assert 'a.txt' not in html

    # Locked download/zip redirect to the landing; thumb is a plain 401.
    rv = client.get(f"/shared-files/{token}/download?id={ids['a']}")
    assert rv.status_code == 303
    rv = client.get(f'/shared-files/{token}/zip')
    assert rv.status_code == 303
    rv = client.get(f"/shared-files/{token}/thumb?id={ids['a']}")
    assert rv.status_code == 401

    # Unlock via the auth form; the cookie then reveals the listing.
    rv = client.post(f'/shared-files/{token}/auth', data={'password': 'pw123'})
    assert rv.status_code == 303
    body = client.get(f'/shared-files/{token}', headers=JSON_ACCEPT).get_json()
    assert body['authed'] is True
    assert [c['name'] for c in body['children']] == ['sub', 'a.txt']


def test_shared_folder_download_scoped(client, app, drive, shares):
    with app.app_context():
        token, ids = _folder_share_fixture(drive, shares)

    # An active descendant file downloads.
    rv = client.get(f"/shared-files/{token}/download?id={ids['b']}")
    assert rv.status_code == 200
    assert rv.data == b'hi'
    rv = client.get(f"/shared-files/{token}/preview?id={ids['b']}")
    assert rv.status_code == 200

    # Outside the subtree → 404.
    assert client.get(
        f"/shared-files/{token}/download?id={ids['outside']}"
    ).status_code == 404
    # The folder root itself has no blob → 404.
    assert client.get(f'/shared-files/{token}/download').status_code == 404
    # A folder id as target → 404.
    assert client.get(
        f"/shared-files/{token}/download?id={ids['sub']}"
    ).status_code == 404
    # A trashed descendant → 404.
    with app.app_context():
        drive.soft_delete([ids['b']])
    assert client.get(
        f"/shared-files/{token}/download?id={ids['b']}"
    ).status_code == 404


def test_shared_folder_zip(client, app, drive, shares):
    import io
    import zipfile

    with app.app_context():
        token, ids = _folder_share_fixture(drive, shares)

    rv = client.get(f'/shared-files/{token}/zip')
    assert rv.status_code == 200
    assert rv.mimetype == 'application/zip'
    assert 'root.zip' in rv.headers['Content-Disposition']
    with zipfile.ZipFile(io.BytesIO(rv.data)) as zf:
        # Root name stripped; contents start at depth 1.
        assert sorted(zf.namelist()) == ['a.txt', 'sub/', 'sub/b.txt']

    # Zip a subfolder of the share.
    rv = client.get(f"/shared-files/{token}/zip?dir={ids['sub']}")
    assert rv.status_code == 200
    assert 'sub.zip' in rv.headers['Content-Disposition']
    with zipfile.ZipFile(io.BytesIO(rv.data)) as zf:
        assert zf.namelist() == ['b.txt']

    # dir outside the subtree → 404.
    assert client.get(
        f"/shared-files/{token}/zip?dir={ids['outside']}"
    ).status_code == 404


def test_shared_file_zip_404(client, app, drive, shares):
    with app.app_context():
        n = _make_file(drive, 'plain.txt')
        _, token = shares.create(n.id, None, None)
    assert client.get(f'/shared-files/{token}/zip').status_code == 404


def test_shared_folder_thumb(client, app, drive, shares):
    import io
    import os

    from PIL import Image

    with app.app_context():
        root = drive.create_folder(None, 'gallery')
        blob_rel = os.path.join('drive', 'pic.png.bin')
        abs_p = drive.blob_abs_path(blob_rel)
        os.makedirs(os.path.dirname(abs_p), exist_ok=True)
        Image.new('RGB', (64, 64), color=(9, 99, 199)).save(abs_p, format='PNG')
        img = drive.create_file_node(
            root.id, 'pic.png', blob_rel, 'imghash', os.path.getsize(abs_p)
        )
        doc = _make_file(drive, 'doc.txt', parent_id=root.id)
        outside = _make_file(drive, 'far.txt')
        _, token = shares.create(root.id, None, None)
        img_id, doc_id, outside_id = img.id, doc.id, outside.id

    rv = client.get(f'/shared-files/{token}/thumb?id={img_id}')
    assert rv.status_code == 200
    assert rv.mimetype == 'image/jpeg'
    assert len(rv.data) > 0

    # Non-image and out-of-subtree targets → 404.
    assert client.get(f'/shared-files/{token}/thumb?id={doc_id}').status_code == 404
    assert client.get(
        f'/shared-files/{token}/thumb?id={outside_id}'
    ).status_code == 404


def test_shared_file_landing_json_has_type(client, app, drive, shares):
    with app.app_context():
        n = _make_file(drive, 'typed.txt')
        _, token = shares.create(n.id, None, None)
    body = client.get(f'/shared-files/{token}', headers=JSON_ACCEPT).get_json()
    assert body['type'] == 'file'
    assert body['name'] == 'typed.txt'
    assert body['size'] == 2
