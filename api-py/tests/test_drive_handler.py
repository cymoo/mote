"""Handler-level smoke test: hit the routes with the Flask test_client to
ensure blueprint wiring + JSON serialization is intact.
"""
from __future__ import annotations


def test_list_root_empty(client):
    rv = client.get('/api/drive/list')
    assert rv.status_code == 200
    assert rv.get_json() == []


def test_create_folder_then_list(client):
    rv = client.post('/api/drive/folder', json={'name': 'docs'})
    assert rv.status_code == 200
    body = rv.get_json()
    assert body['name'] == 'docs'
    assert body['type'] == 'folder'
    folder_id = body['id']

    rv = client.get('/api/drive/list')
    assert rv.status_code == 200
    items = rv.get_json()
    assert len(items) == 1
    assert items[0]['id'] == folder_id


def test_invalid_folder_name(client):
    rv = client.post('/api/drive/folder', json={'name': ''})
    assert rv.status_code in (400, 422)


def test_create_folder_conflict(client):
    client.post('/api/drive/folder', json={'name': 'dup'})
    rv = client.post('/api/drive/folder', json={'name': 'dup'})
    assert rv.status_code == 409


def test_breadcrumbs(client):
    rv = client.post('/api/drive/folder', json={'name': 'a'})
    a_id = rv.get_json()['id']
    rv = client.post('/api/drive/folder', json={'name': 'b', 'parent_id': a_id})
    b_id = rv.get_json()['id']

    rv = client.get(f'/api/drive/breadcrumbs?id={b_id}')
    assert rv.status_code == 200
    bc = rv.get_json()
    assert [x['name'] for x in bc] == ['a', 'b']


def test_trash_route(client):
    rv = client.post('/api/drive/folder', json={'name': 'tmp'})
    nid = rv.get_json()['id']
    rv = client.post('/api/drive/delete', json={'ids': [nid]})
    assert rv.status_code == 204

    rv = client.get('/api/drive/trash')
    assert rv.status_code == 200
    items = rv.get_json()
    assert len(items) == 1
    assert items[0]['id'] == nid


def test_share_unknown_token_landing(client):
    rv = client.get('/shared-files/nonexistent')
    assert rv.status_code == 404


def test_star_starred_roundtrip(client):
    rv = client.post('/api/drive/folder', json={'name': 'fav'})
    nid = rv.get_json()['id']
    assert rv.get_json()['starred_at'] is None

    rv = client.post('/api/drive/star', json={'ids': [nid], 'starred': True})
    assert rv.status_code == 204

    rv = client.get('/api/drive/starred')
    assert rv.status_code == 200
    items = rv.get_json()
    assert [x['id'] for x in items] == [nid]
    assert items[0]['starred_at'] is not None

    rv = client.post('/api/drive/star', json={'ids': [nid], 'starred': False})
    assert rv.status_code == 204
    assert client.get('/api/drive/starred').get_json() == []


def test_copy_route(client):
    rv = client.post('/api/drive/folder', json={'name': 'orig'})
    nid = rv.get_json()['id']

    rv = client.post('/api/drive/copy', json={'ids': [nid], 'new_parent_id': None})
    assert rv.status_code == 200
    out = rv.get_json()
    assert len(out) == 1
    assert out[0]['name'] == 'orig (1)'

    # Copying a folder into itself is a 400 (cycle).
    rv = client.post('/api/drive/copy', json={'ids': [nid], 'new_parent_id': nid})
    assert rv.status_code == 400

    # Unknown source id is a 404.
    rv = client.post('/api/drive/copy', json={'ids': [999999]})
    assert rv.status_code == 404


def test_usage_route(client):
    rv = client.get('/api/drive/usage')
    assert rv.status_code == 200
    body = rv.get_json()
    assert body.keys() >= {
        'active_bytes', 'trash_bytes', 'physical_bytes',
        'active_count', 'trash_count',
    }
    assert body['active_count'] == 0


def test_ensure_path_route(client):
    rv = client.post(
        '/api/drive/folders/ensure-path', json={'parent_id': None, 'path': 'a/b/c'}
    )
    assert rv.status_code == 200
    leaf = rv.get_json()
    assert leaf['name'] == 'c'
    assert leaf['type'] == 'folder'

    # Idempotent.
    rv = client.post(
        '/api/drive/folders/ensure-path', json={'parent_id': None, 'path': 'a/b/c'}
    )
    assert rv.get_json()['id'] == leaf['id']

    rv = client.post(
        '/api/drive/folders/ensure-path', json={'parent_id': None, 'path': '../up'}
    )
    assert rv.status_code == 400
