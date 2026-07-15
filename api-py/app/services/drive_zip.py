"""Streaming ZIP archive helper for the drive service.

Mirrors api-go/internal/services/drive_zip.go. Kept as module-level
functions so the heavy zip logic is independently readable and the
DriveService class stays focused on tree CRUD.
"""
from __future__ import annotations

import io
import json
import os
import zipfile
from typing import Iterator

from sqlalchemy import text

from ..extension import db
from .drive import DriveNodeRow, DriveNotFound, DriveService


__all__ = ['zip_folder_iter', 'zip_nodes_iter']


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


def zip_nodes_iter(service: DriveService, ids: list[int]) -> Iterator[bytes]:
    """Stream a ZIP archive of an arbitrary node selection.

    Unlike :func:`zip_folder_iter` — which strips the root folder's own name —
    selected folders appear as top-level directories and selected files as
    top-level entries. Ids nested under other selected ids are skipped (their
    content arrives via the ancestor). Same-named top-level entries get a
    "name (1)" suffix rather than being silently dropped: a multi-select from
    search results can legitimately pick same-named nodes from different
    folders.

    Targets are resolved eagerly, so :class:`DriveNotFound` is raised before
    any body bytes exist when no valid node remains — the handler can still
    send a clean 404.
    """
    uniq: list[int] = []
    seen_ids: set[int] = set()
    for nid in ids:
        if nid in seen_ids:
            continue
        seen_ids.add(nid)
        uniq.append(nid)

    nested = _nested_selections(uniq)
    targets: list[DriveNodeRow] = []
    for nid in uniq:
        if nid in nested:
            continue
        try:
            n = service.find_by_id(nid)
        except DriveNotFound:
            continue
        if n.deleted_at is not None:
            continue
        targets.append(n)
    if not targets:
        raise DriveNotFound('drive node not found')

    def gen() -> Iterator[bytes]:
        buf = _ChunkBuffer()
        with zipfile.ZipFile(buf, mode='w', compression=zipfile.ZIP_DEFLATED) as zf:
            top_level: set[str] = set()
            for root in targets:
                if root.type == 'file':
                    name = _unique_top_level(
                        top_level, _sanitize_zip_path(root.name)
                    )
                    if not name or not root.blob_path:
                        continue
                    yield from _stream_blob_entry(service, zf, buf, name, root.blob_path)
                    continue

                descendants = service.collect_descendants(root.id)
                top_name = _unique_top_level(
                    top_level, _sanitize_zip_path(root.name)
                )
                if not top_name:
                    continue
                seen: set[str] = set()
                for d in descendants:
                    if d.id == root.id:
                        rel = top_name
                    else:
                        # rel_path starts with the root's own name; swap it
                        # for the (possibly suffixed) reserved top-level name.
                        sub = d.rel_path
                        if sub.startswith(root.name):
                            sub = sub[len(root.name):]
                        if sub.startswith('/'):
                            sub = sub[1:]
                        sub = _sanitize_zip_path(sub)
                        if not sub:
                            continue
                        rel = top_name + '/' + sub
                    if rel in seen:
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
                    yield from _stream_blob_entry(service, zf, buf, rel, d.blob_path)

        tail = buf.drain()
        if tail:
            yield tail

    return gen()


def _stream_blob_entry(
    service: DriveService,
    zf: zipfile.ZipFile,
    buf: '_ChunkBuffer',
    rel: str,
    blob_path: str,
) -> Iterator[bytes]:
    """Stream one stored blob into an open archive, yielding drained chunks.
    A blob missing on disk is skipped (matches zip_folder_iter).
    """
    abs_path = service.blob_abs_path(blob_path)
    if not os.path.exists(abs_path):
        return
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


def _nested_selections(ids: list[int]) -> set[int]:
    """Return the subset of ids that are strict descendants of other ids in
    the same selection (possible when multi-selecting from search results,
    where ancestors and descendants can appear side by side).
    """
    if len(ids) < 2:
        return set()
    rows = db.session.execute(
        text(
            'WITH RECURSIVE selected(id) AS ('
            '  SELECT value FROM json_each(:ids)'
            '), '
            'descendants(id) AS ('
            '  SELECT n.id FROM drive_nodes n '
            '  WHERE n.parent_id IN (SELECT id FROM selected) '
            '  UNION ALL '
            '  SELECT n.id FROM drive_nodes n JOIN descendants d ON n.parent_id = d.id'
            ') SELECT id FROM selected WHERE id IN (SELECT id FROM descendants)'
        ),
        {'ids': json.dumps(ids)},
    ).all()
    return {r.id for r in rows}


def _unique_top_level(seen: set[str], name: str) -> str:
    """Reserve a unique top-level entry name, suffixing "stem (1).ext" style
    on collision.
    """
    if not name:
        return ''
    cand = name
    i = 1
    while cand in seen:
        stem, ext = os.path.splitext(name)
        cand = f'{stem} ({i}){ext}'
        i += 1
    seen.add(cand)
    return cand


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
