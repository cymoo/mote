"""Tests for thumbnail generation."""
from __future__ import annotations

import os

import pytest
from flask import current_app
from PIL import Image

from app.services.drive import THUMB_WIDTH, DriveNotImage
from app.services.drive_thumb import make_thumbnail


@pytest.fixture()
def drive(app, clean_drive):
    with app.app_context():
        yield current_app.drive_service


def _make_image_node(drive, name='photo.jpg', size=(800, 600)):
    blob_rel = os.path.join('drive', name + '.bin')
    abs_p = drive.blob_abs_path(blob_rel)
    os.makedirs(os.path.dirname(abs_p), exist_ok=True)
    img = Image.new('RGB', size, color=(120, 200, 80))
    img.save(abs_p, format='JPEG')
    file_size = os.path.getsize(abs_p)
    return drive.create_file_node(None, name, blob_rel, 'deadbeef', file_size)


def test_thumb_generated_at_240px(drive):
    n = _make_image_node(drive, 'photo.jpg', size=(800, 600))
    thumb_abs = make_thumbnail(drive, n.id)
    assert os.path.exists(thumb_abs)
    with Image.open(thumb_abs) as t:
        assert t.size[0] == THUMB_WIDTH
        assert t.size[1] == 600 * THUMB_WIDTH // 800


def test_thumb_cached_on_second_call(drive):
    n = _make_image_node(drive, 'photo.jpg', size=(800, 600))
    p1 = make_thumbnail(drive, n.id)
    mtime = os.path.getmtime(p1)
    p2 = make_thumbnail(drive, n.id)
    assert p1 == p2
    assert os.path.getmtime(p2) == mtime  # not regenerated


def test_thumb_smaller_than_240_keeps_size(drive):
    n = _make_image_node(drive, 'tiny.jpg', size=(100, 50))
    thumb_abs = make_thumbnail(drive, n.id)
    with Image.open(thumb_abs) as t:
        assert t.size[0] == 100  # not upscaled


def test_thumb_non_image_raises(drive):
    blob_rel = os.path.join('drive', 'doc.bin')
    abs_p = drive.blob_abs_path(blob_rel)
    os.makedirs(os.path.dirname(abs_p), exist_ok=True)
    with open(abs_p, 'wb') as f:
        f.write(b'not an image')
    n = drive.create_file_node(None, 'doc.txt', blob_rel, 'x', 12)
    with pytest.raises(DriveNotImage):
        make_thumbnail(drive, n.id)


def test_thumb_missing_source_blob_raises_not_found(drive):
    """If the source blob is gone from disk (e.g. external cleanup), we must
    surface a clean DriveNotFound -> 404, not a bare FileNotFoundError -> 500.
    """
    from app.services.drive import DriveNotFound

    n = _make_image_node(drive, 'gone.jpg', size=(200, 200))
    os.remove(drive.blob_abs_path(n.blob_path))
    with pytest.raises(DriveNotFound):
        make_thumbnail(drive, n.id)
