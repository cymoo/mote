"""Image thumbnail helper for the drive service.

Mirrors api-go/internal/services/drive_thumb.go. Module-level functions so
the DriveService class stays focused on tree CRUD.
"""
from __future__ import annotations

import os
import threading

from .drive import (
    DriveError,
    DriveNotFound,
    DriveNotImage,
    DriveService,
    IMAGE_EXTS,
    THUMB_WIDTH,
)


__all__ = ['make_thumbnail', 'purge_thumb', 'thumb_dir']


_thumb_locks: dict[str, threading.Lock] = {}
_thumb_locks_guard = threading.Lock()


def _key_lock(key: str) -> threading.Lock:
    """Return a per-thumbnail-path lock so two concurrent requests don't
    rebuild the same thumbnail twice.
    """
    with _thumb_locks_guard:
        lock = _thumb_locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _thumb_locks[key] = lock
    return lock


def thumb_dir(base_path: str) -> str:
    return os.path.join(base_path, 'drive', '_thumbs')


def make_thumbnail(service: DriveService, node_id: int) -> str:
    """Build (or reuse) the JPEG thumbnail for an image node and return the
    absolute thumbnail path.

    Raises :class:`DriveNotFound` if the node isn't an active file, or
    :class:`DriveNotImage` if the file isn't a supported image type.
    """
    from PIL import Image, ImageOps

    n = service.find_by_id(node_id)
    if n.type != 'file' or not n.blob_path or n.deleted_at is not None:
        raise DriveNotFound('drive node not found')
    ext = os.path.splitext(n.name)[1].lower()
    if ext not in IMAGE_EXTS:
        raise DriveNotImage('not an image')

    src_abs = service.blob_abs_path(n.blob_path)
    if not os.path.exists(src_abs):
        raise DriveNotFound('source file not found on disk')
    thumbs_dir = thumb_dir(service.base_path)
    os.makedirs(thumbs_dir, exist_ok=True)
    thumb_abs = os.path.join(thumbs_dir, os.path.basename(n.blob_path) + '.jpg')

    if _is_present(thumb_abs):
        return thumb_abs

    with _key_lock(thumb_abs):
        if _is_present(thumb_abs):
            return thumb_abs

        with Image.open(src_abs) as img:
            img = ImageOps.exif_transpose(img)
            w, h = img.size
            if w == 0 or h == 0:
                raise DriveError('zero-dimension image')
            tw = THUMB_WIDTH if w >= THUMB_WIDTH else w
            th = max(1, h * tw // w)
            thumb = img.convert('RGB').resize((tw, th), Image.LANCZOS)

        tmp = thumb_abs + '.part'
        try:
            thumb.save(tmp, format='JPEG', quality=82)
            os.replace(tmp, thumb_abs)
        except Exception:
            try:
                os.remove(tmp)
            except OSError:
                pass
            raise

    return thumb_abs


def purge_thumb(base_path: str, blob_path: str) -> None:
    """Best-effort delete of the cached thumbnail for ``blob_path``."""
    if not blob_path:
        return
    thumb_abs = os.path.join(
        thumb_dir(base_path), os.path.basename(blob_path) + '.jpg'
    )
    try:
        os.remove(thumb_abs)
    except OSError:
        pass


def _is_present(path: str) -> bool:
    return os.path.exists(path) and os.path.getsize(path) > 0
