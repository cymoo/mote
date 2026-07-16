"""Tests for the drive tree service: list/CRUD/move/rename/trash/restore/purge."""
from __future__ import annotations

import os

import pytest
from flask import current_app

from app.services.drive import (
    DriveCycle,
    DriveInvalidName,
    DriveNameConflict,
    DriveNotFolder,
    DriveNotFound,
)


@pytest.fixture()
def svc(app, clean_drive):
    with app.app_context():
        yield current_app.drive_service


def _file_node(svc, parent_id, name, content=b'hello'):
    """Helper: create a file node directly via the service (skipping upload)."""
    blob_rel = os.path.join('drive', name + '.bin')
    abs_p = svc.blob_abs_path(blob_rel)
    os.makedirs(os.path.dirname(abs_p), exist_ok=True)
    with open(abs_p, 'wb') as f:
        f.write(content)
    return svc.create_file_node(
        parent_id, name, blob_rel, 'deadbeef', len(content)
    )


def test_create_folder_and_list_root(svc):
    f = svc.create_folder(None, 'docs')
    assert f.id > 0
    assert f.parent_id is None
    assert f.type == 'folder'

    rows = svc.list(None, None)
    assert len(rows) == 1
    assert rows[0].name == 'docs'


def test_create_folder_invalid_name(svc):
    with pytest.raises(DriveInvalidName):
        svc.create_folder(None, '')
    with pytest.raises(DriveInvalidName):
        svc.create_folder(None, 'a/b')


def test_create_folder_name_conflict(svc):
    svc.create_folder(None, 'dup')
    with pytest.raises(DriveNameConflict):
        svc.create_folder(None, 'dup')
    # Case-insensitive
    with pytest.raises(DriveNameConflict):
        svc.create_folder(None, 'DUP')


def test_list_within_folder(svc):
    f = svc.create_folder(None, 'parent')
    child = svc.create_folder(f.id, 'child')
    file = _file_node(svc, f.id, 'file1')

    rows = svc.list(f.id, None)
    assert {r.name for r in rows} == {'child', 'file1'}
    # Folders before files
    assert rows[0].name == 'child'


def test_list_search_query(svc):
    a = svc.create_folder(None, 'alpha')
    svc.create_folder(None, 'beta')
    svc.create_folder(a.id, 'alpha-child')
    rows = svc.list(None, 'alpha')
    names = {r.name for r in rows}
    assert names == {'alpha', 'alpha-child'}


def test_list_nonexistent_parent(svc):
    with pytest.raises(DriveNotFound):
        svc.list(99999, None)


def test_breadcrumbs(svc):
    a = svc.create_folder(None, 'a')
    b = svc.create_folder(a.id, 'b')
    c = svc.create_folder(b.id, 'c')
    bc = svc.breadcrumbs(c.id)
    assert [x['name'] for x in bc] == ['a', 'b', 'c']


def test_rename(svc):
    f = svc.create_folder(None, 'orig')
    svc.rename(f.id, 'renamed')
    rows = svc.list(None, None)
    assert rows[0].name == 'renamed'


def test_rename_conflict(svc):
    a = svc.create_folder(None, 'a')
    b = svc.create_folder(None, 'b')
    with pytest.raises(DriveNameConflict):
        svc.rename(b.id, 'a')


def test_move(svc):
    f1 = svc.create_folder(None, 'f1')
    f2 = svc.create_folder(None, 'f2')
    child = svc.create_folder(f1.id, 'child')

    svc.move([child.id], f2.id)
    rows_f1 = svc.list(f1.id, None)
    rows_f2 = svc.list(f2.id, None)
    assert rows_f1 == []
    assert len(rows_f2) == 1
    assert rows_f2[0].name == 'child'


def test_move_cycle(svc):
    a = svc.create_folder(None, 'a')
    b = svc.create_folder(a.id, 'b')
    # Moving 'a' under its own descendant 'b' must fail.
    with pytest.raises(DriveCycle):
        svc.move([a.id], b.id)


def test_move_into_file_fails(svc):
    f = _file_node(svc, None, 'f.txt')
    other = svc.create_folder(None, 'other')
    with pytest.raises(DriveNotFolder):
        svc.move([other.id], f.id)


def test_soft_delete_and_restore(svc):
    f = svc.create_folder(None, 'doomed')
    child = svc.create_folder(f.id, 'child')

    svc.soft_delete([f.id])

    rows = svc.list(None, None)
    assert rows == []

    trash = svc.list_trash()
    # Trash returns only top-level deleted items (batch heads), not children.
    assert len(trash) == 1
    assert trash[0].id == f.id

    svc.restore(f.id)
    rows = svc.list(None, None)
    assert len(rows) == 1
    # Children also restored
    sub = svc.list(f.id, None)
    assert len(sub) == 1
    assert sub[0].id == child.id


def test_purge(svc):
    f = svc.create_folder(None, 'tmp')
    file = _file_node(svc, f.id, 'inside')
    svc.soft_delete([f.id])

    blob_abs = svc.blob_abs_path(file.blob_path)
    assert os.path.exists(blob_abs)

    svc.purge([f.id])
    assert svc.list_trash() == []
    assert not os.path.exists(blob_abs)


def test_empty_trash_with_cascading_batches(svc):
    """Emptying a trash that holds both a folder and its separately-batched
    deleted children must succeed: purging the folder cascade-deletes the
    children, so purging the (now-gone) children must be tolerated, not raise.
    Repro: delete 2 files from a folder, move a 3rd out, then delete the folder.
    """
    folder = svc.create_folder(None, 'F')
    a = _file_node(svc, folder.id, 'a.txt')
    b = _file_node(svc, folder.id, 'b.txt')
    c = _file_node(svc, folder.id, 'c.txt')

    # Delete a & b from inside the folder (batch 1).
    svc.soft_delete([a.id, b.id])
    # Move c out of the folder to the root.
    svc.move([c.id], None)
    # Delete the folder itself (batch 2); a & b stay trashed inside it.
    svc.soft_delete([folder.id])

    # Trash shows a, b and F as three separate roots (different batches).
    ids = [t.id for t in svc.list_trash()]
    assert len(ids) == 3
    assert set(ids) == {a.id, b.id, folder.id}

    # Empty the trash — purge the folder first so its cascade removes a & b,
    # then purging the now-gone a & b must be tolerated rather than raise.
    svc.purge([folder.id] + [i for i in ids if i != folder.id])

    # Every trashed row is gone; c (moved out, still active) survives.
    assert svc.list_trash() == []
    for gone in (folder.id, a.id, b.id):
        with pytest.raises(DriveNotFound):
            svc.find_by_id(gone)
    assert svc.find_by_id(c.id).id == c.id


def _shared_blob(svc, rel_name, content=b'shared'):
    """Helper: write one blob file and return its drive-relative path."""
    blob_rel = os.path.join('drive', rel_name)
    abs_p = svc.blob_abs_path(blob_rel)
    os.makedirs(os.path.dirname(abs_p), exist_ok=True)
    with open(abs_p, 'wb') as f:
        f.write(content)
    return blob_rel


def test_purge_keeps_shared_blob(svc):
    """Purging one of two nodes that share a blob (copy / deduplicated upload)
    must keep the blob file; purging the last reference removes it.
    """
    blob = _shared_blob(svc, 'shared.txt')
    abs_p = svc.blob_abs_path(blob)
    a = svc.create_file_node(None, 'a.txt', blob, 'h', 6)
    b = svc.create_file_node(None, 'b.txt', blob, 'h', 6)

    svc.purge([a.id])
    assert os.path.exists(abs_p), 'blob removed while still referenced'

    svc.purge([b.id])
    assert not os.path.exists(abs_p), 'blob should be gone after last reference'


def test_replace_keeps_shared_blob(svc):
    """Overwriting one of two nodes that share a blob must not delete the blob
    the other node still references; overwriting the last reference removes it.
    """
    old_blob = _shared_blob(svc, 'old.txt', b'old')
    new_blob = _shared_blob(svc, 'new.txt', b'new')

    svc.create_file_node(None, 'a.txt', old_blob, 'h', 3)
    svc.create_file_node(None, 'b.txt', old_blob, 'h', 3)

    # Overwrite a.txt with the new blob; the old blob is still used by b.txt.
    svc.replace_file_node(None, 'a.txt', new_blob, 'h2', 3)
    assert os.path.exists(svc.blob_abs_path(old_blob)), 'shared old blob removed'

    # Overwrite b.txt too — the old blob is now orphaned and must go.
    svc.replace_file_node(None, 'b.txt', new_blob, 'h2', 3)
    assert not os.path.exists(svc.blob_abs_path(old_blob))


def test_purge_old_trash_keeps_shared_blob(svc):
    """The scheduled trash purge inherits refcounted blob removal: a trashed
    row's blob survives while an active copy still references it.
    """
    from app.models import utc_now_ms

    blob = _shared_blob(svc, 'trashy.txt')
    doomed = svc.create_file_node(None, 'doomed.txt', blob, 'h', 6)
    svc.create_file_node(None, 'keeper.txt', blob, 'h', 6)

    svc.soft_delete([doomed.id])
    purged = svc.purge_old_trash(utc_now_ms() + 1000)
    assert purged == 1
    assert os.path.exists(svc.blob_abs_path(blob))


def _insert_share(node_id):
    """Helper: insert a bare drive_shares row (mirrors Go's raw INSERT)."""
    from sqlalchemy import text

    from app.extension import db

    db.session.execute(
        text(
            'INSERT INTO drive_shares '
            '(node_id, token_hash, token_prefix, expires_at, created_at) '
            "VALUES (:nid, :h, :p, NULL, 1)"
        ),
        {'nid': node_id, 'h': f'tk{node_id}', 'p': f'tk{node_id}'},
    )
    db.session.commit()


def test_copy_file_shares_blob_and_strips_meta(svc):
    """A file copy shares the source's blob and never carries stars or shares."""
    from sqlalchemy import text

    from app.extension import db

    dest = svc.create_folder(None, 'dest')
    blob = _shared_blob(svc, 'src.txt', b'x')
    src = svc.create_file_node(None, 'src.txt', blob, 'h', 1)
    svc.set_starred([src.id], True)
    _insert_share(src.id)

    out = svc.copy([src.id], dest.id)
    assert len(out) == 1
    cp = out[0]
    assert cp.id != src.id, 'copy must be a fresh row'
    assert cp.blob_path == blob, 'copy should share blob'
    assert cp.starred_at is None, 'copy must not inherit the star'
    shares = db.session.execute(
        text('SELECT COUNT(*) FROM drive_shares WHERE node_id = :id'),
        {'id': cp.id},
    ).scalar()
    assert shares == 0, 'copy must not inherit shares'


def test_copy_folder_recursive(svc):
    """Copying a folder replicates the whole subtree; the root gets renamed on
    destination conflicts while children keep their names.
    """
    a = svc.create_folder(None, 'a')
    b = svc.create_folder(a.id, 'b')
    blob = _shared_blob(svc, 'c.txt', b'c')
    svc.create_file_node(b.id, 'c.txt', blob, 'h', 1)
    svc.create_file_node(a.id, 'd.txt', blob, 'h', 1)

    # Copy a → root: name "a" is taken by the source itself → "a (1)".
    out = svc.copy([a.id], None)
    root = out[0]
    assert root.name == 'a (1)'

    l1 = svc.list(root.id, None, 'name', 'asc')
    assert [n.name for n in l1] == ['b', 'd.txt']
    l2 = svc.list(l1[0].id, None, 'name', 'asc')
    assert len(l2) == 1
    assert l2[0].name == 'c.txt'
    assert l2[0].blob_path == blob


def test_copy_into_own_subtree_rejected(svc):
    """Copying a folder into itself or its own descendant is rejected."""
    a = svc.create_folder(None, 'a')
    b = svc.create_folder(a.id, 'b')

    with pytest.raises(DriveCycle):
        svc.copy([a.id], b.id)
    with pytest.raises(DriveCycle):
        svc.copy([a.id], a.id)


def test_duplicate_in_place_twice(svc):
    """Duplicate-in-place twice yields "x (1)" then "x (2)"."""
    parent = svc.create_folder(None, 'p')
    blob = _shared_blob(svc, 'x.txt', b'x')
    src = svc.create_file_node(parent.id, 'x.txt', blob, 'h', 1)

    c1 = svc.copy([src.id], parent.id)
    c2 = svc.copy([src.id], parent.id)
    assert c1[0].name == 'x (1).txt'
    assert c2[0].name == 'x (2).txt'


def test_star_unstar_and_list(svc):
    """Star/unstar toggling, trash filtering, and the starred listing."""
    folder = svc.create_folder(None, 'f')
    blob = _shared_blob(svc, 's.txt', b's')
    file = svc.create_file_node(folder.id, 's.txt', blob, 'h', 1)

    svc.set_starred([folder.id, file.id], True)
    out = svc.list_starred()
    assert len(out) == 2
    for n in out:
        if n.id == file.id:
            assert n.path == 'f'

    # Trashed items disappear from the listing but keep their star.
    svc.soft_delete([file.id])
    out = svc.list_starred()
    assert len(out) == 1
    assert out[0].id == folder.id
    svc.restore(file.id)
    out = svc.list_starred()
    assert len(out) == 2

    # Unstar both.
    svc.set_starred([folder.id, file.id], False)
    assert svc.list_starred() == []


def test_star_does_not_bump_updated_at(svc):
    """Starring is a metadata toggle: updated_at must stay put so the
    "modified" sort remains stable.
    """
    folder = svc.create_folder(None, 'stable')
    before = svc.find_by_id(folder.id).updated_at
    svc.set_starred([folder.id], True)
    after = svc.find_by_id(folder.id)
    assert after.starred_at is not None
    assert after.updated_at == before


def test_ensure_folder_path(svc):
    """ensure_folder_path creates missing segments, reuses existing ones
    (case-insensitively), and refuses paths blocked by files or containing
    invalid segments.
    """
    leaf = svc.ensure_folder_path(None, 'a/b/c')
    assert leaf.type == 'folder'
    assert leaf.name == 'c'
    bc = svc.breadcrumbs(leaf.id)
    assert [x['name'] for x in bc] == ['a', 'b', 'c']

    # Idempotent: the second call returns the same folder.
    again = svc.ensure_folder_path(None, 'a/b/c')
    assert again.id == leaf.id

    # Case-insensitive reuse of existing segments.
    b = svc.ensure_folder_path(None, 'A/B')
    assert b.id == bc[1]['id']

    # A file blocking the path → conflict, not auto-rename.
    blob = _shared_blob(svc, 'block.txt', b'x')
    svc.create_file_node(None, 'block.txt', blob, '', 1)
    with pytest.raises(DriveNameConflict):
        svc.ensure_folder_path(None, 'block.txt/sub')

    # Invalid segments rejected.
    with pytest.raises(DriveInvalidName):
        svc.ensure_folder_path(None, '../evil')
    with pytest.raises(DriveInvalidName):
        svc.ensure_folder_path(None, '///')


def test_share_counts_include_folders(svc):
    """Folder nodes now surface share counts too (folder shares)."""
    folder = svc.create_folder(None, 'shared-folder')
    _insert_share(folder.id)

    out = svc.list(None, None)
    assert len(out) == 1
    assert out[0].share_count == 1


def test_usage(svc):
    """Usage counts logical bytes per row but each distinct blob only once."""
    blob_x = _shared_blob(svc, 'x.bin', b'xxxxx')
    blob_y = _shared_blob(svc, 'y.bin', b'yyyyyyy')

    f1 = svc.create_file_node(None, 'one.bin', blob_x, 'hx', 5)
    svc.copy([f1.id], None)  # shares blob_x
    f3 = svc.create_file_node(None, 'three.bin', blob_y, 'hy', 7)
    svc.soft_delete([f3.id])

    u = svc.usage()
    assert u['active_bytes'] == 10
    assert u['active_count'] == 2
    assert u['trash_bytes'] == 7
    assert u['trash_count'] == 1
    assert u['physical_bytes'] == 12
    # Free/total disk space of the tmp uploads filesystem (df-style).
    assert 0 < u['free_bytes'] <= u['total_bytes']
