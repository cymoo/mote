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
