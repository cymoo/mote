"""Streaming ZIP archive helper for the drive service.

Mirrors api-go/internal/services/drive_zip.go. Kept as module-level
functions so the heavy zip logic is independently readable and the
DriveService class stays focused on tree CRUD.
"""
from __future__ import annotations

import io
import os
import zipfile
from typing import Iterator

from .drive import DriveNotFound, DriveService


__all__ = ['zip_folder_iter']


def zip_folder_iter(service: DriveService, folder_id: int) -> Iterator[bytes]:
    """Stream a ZIP archive of ``folder_id`` and its descendants.

    Yields ``bytes`` chunks suitable for ``Response(stream_with_context(...))``.
    Raises :class:`DriveNotFound` if ``folder_id`` isn't an active folder.
    """
    root = service.find_by_id(folder_id)
    if root.type != 'folder' or root.deleted_at is not None:
        raise DriveNotFound('drive node not found')

    descendants = service.collect_descendants(folder_id)
    buf = _ChunkBuffer()

    with zipfile.ZipFile(buf, mode='w', compression=zipfile.ZIP_DEFLATED) as zf:
        seen: set[str] = set()
        for d in descendants:
            if d.id == folder_id:
                continue

            rel = d.rel_path
            if rel.startswith(root.name):
                rel = rel[len(root.name):]
            if rel.startswith('/'):
                rel = rel[1:]
            rel = _sanitize_zip_path(rel)
            if not rel or rel in seen:
                continue
            seen.add(rel)

            if d.type == 'folder':
                zi = zipfile.ZipInfo(rel + '/')
                zi.compress_type = zipfile.ZIP_DEFLATED
                zf.writestr(zi, b'')
                chunk = buf.drain()
                if chunk:
                    yield chunk
                continue

            if not d.blob_path:
                continue
            abs_path = service.blob_abs_path(d.blob_path)
            if not os.path.exists(abs_path):
                continue

            zi = zipfile.ZipInfo(rel)
            zi.compress_type = zipfile.ZIP_DEFLATED
            with zf.open(zi, mode='w', force_zip64=True) as zw, open(
                abs_path, 'rb'
            ) as src:
                while True:
                    block = src.read(64 * 1024)
                    if not block:
                        break
                    zw.write(block)
                    chunk = buf.drain()
                    if chunk:
                        yield chunk

    tail = buf.drain()
    if tail:
        yield tail


def _sanitize_zip_path(p: str) -> str:
    out: list[str] = []
    for seg in p.split('/'):
        seg = seg.strip()
        if not seg or seg in ('.', '..'):
            continue
        out.append(seg)
    return '/'.join(out)


class _ChunkBuffer(io.RawIOBase):
    """In-memory buffer that lets a ``ZipFile`` write into a FIFO we drain
    between entries to support streaming responses.
    """

    def __init__(self) -> None:
        self._buf = bytearray()

    def writable(self) -> bool:  # noqa: D401 - documented in io.RawIOBase
        return True

    def write(self, b) -> int:  # type: ignore[override]
        self._buf.extend(b)
        return len(b)

    def drain(self) -> bytes:
        out = bytes(self._buf)
        self._buf.clear()
        return out
