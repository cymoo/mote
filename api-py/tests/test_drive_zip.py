"""Tests for streaming zip download of a folder tree."""
from __future__ import annotations

import io
import os
import zipfile

import pytest
from flask import current_app

from app.services.drive_zip import zip_folder_iter


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
