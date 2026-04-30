"""Drive upload service — chunked uploads.

Translation of api-go/internal/services/drive_upload.go.
"""
from __future__ import annotations

import hashlib
import os
import shutil
import threading
import uuid
from dataclasses import dataclass
from typing import Optional

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from ..extension import db
from ..model import utc_now_ms
from .drive import (
    DriveError,
    DriveNameConflict,
    DriveNotFound,
    DriveService,
    new_blob_name,
    valid_name,
)


MAX_FILE_SIZE = 4 << 30  # 4 GiB
DEFAULT_CHUNK_SIZE = 8 << 20  # 8 MiB
MIN_CHUNK_SIZE = 1 << 20  # 1 MiB
MAX_CHUNK_SIZE = 64 << 20  # 64 MiB
UPLOAD_TTL_MS = 24 * 60 * 60 * 1000


class UploadNotFound(DriveError):
    pass


class UploadInvalid(DriveError):
    pass


class UploadCollision(DriveError):
    """Raised when on_collision='ask' and a same-name file already exists."""


class UploadGone(DriveError):
    pass


@dataclass
class UploadStatus:
    upload_id: str
    parent_id: Optional[int]
    name: str
    size: int
    chunk_size: int
    total_chunks: int
    received_chunks: list[int]
    status: str

    def to_dict(self) -> dict:
        return {
            'upload_id': self.upload_id,
            'parent_id': self.parent_id,
            'name': self.name,
            'size': self.size,
            'chunk_size': self.chunk_size,
            'total_chunks': self.total_chunks,
            'received_chunks': self.received_chunks,
            'status': self.status,
        }


def _decode_mask(buf: bytes, total: int) -> list[int]:
    out = []
    for i in range(total):
        if buf[i // 8] & (1 << (i % 8)):
            out.append(i)
    return out


class DriveUploadService:
    # Per-upload locks so concurrent PUT chunks for the same upload don't
    # race when OR-masking the bitmap. Cross-process safety relies on SQLite
    # transactions; this just removes intra-process contention.
    _locks: dict[str, threading.Lock] = {}
    _locks_guard = threading.Lock()

    def __init__(self, drive: DriveService):
        self.drive = drive

    # -- helpers --------------------------------------------------------------

    @classmethod
    def _lock_for(cls, upload_id: str) -> threading.Lock:
        with cls._locks_guard:
            l = cls._locks.get(upload_id)
            if l is None:
                l = threading.Lock()
                cls._locks[upload_id] = l
        return l

    def _chunks_dir(self, upload_id: str) -> str:
        return os.path.join(self.drive.base_path, 'drive', '_chunks', upload_id)

    def _chunk_path(self, upload_id: str, idx: int) -> str:
        return os.path.join(self._chunks_dir(upload_id), f'{idx:06d}')

    # -- API ------------------------------------------------------------------

    def init(
        self,
        parent_id: Optional[int],
        name: str,
        size: int,
        chunk_size: Optional[int],
    ) -> UploadStatus:
        valid_name(name)
        if size <= 0 or size > MAX_FILE_SIZE:
            raise UploadInvalid('invalid size')
        cs = chunk_size or DEFAULT_CHUNK_SIZE
        if cs < MIN_CHUNK_SIZE or cs > MAX_CHUNK_SIZE:
            raise UploadInvalid('invalid chunk_size')
        if parent_id is not None:
            self.drive._require_active_folder(parent_id)
        total = (size + cs - 1) // cs
        mask = bytes((total + 7) // 8)
        upload_id = uuid.uuid4().hex
        now = utc_now_ms()
        try:
            db.session.execute(
                text(
                    'INSERT INTO drive_uploads '
                    '(id, parent_id, name, size, chunk_size, total_chunks, '
                    'received_mask, status, expires_at, created_at, updated_at) '
                    "VALUES (:id, :pid, :name, :size, :cs, :total, :mask, "
                    "'uploading', :exp, :now, :now)"
                ),
                {
                    'id': upload_id,
                    'pid': parent_id,
                    'name': name,
                    'size': size,
                    'cs': cs,
                    'total': total,
                    'mask': mask,
                    'exp': now + UPLOAD_TTL_MS,
                    'now': now,
                },
            )
            db.session.commit()
        except Exception:
            db.session.rollback()
            raise
        os.makedirs(self._chunks_dir(upload_id), exist_ok=True)
        return UploadStatus(
            upload_id=upload_id,
            parent_id=parent_id,
            name=name,
            size=size,
            chunk_size=cs,
            total_chunks=total,
            received_chunks=[],
            status='uploading',
        )

    def get(self, upload_id: str) -> UploadStatus:
        row = db.session.execute(
            text('SELECT * FROM drive_uploads WHERE id = :id'),
            {'id': upload_id},
        ).first()
        if row is None:
            raise UploadNotFound('upload not found')
        if row.expires_at < utc_now_ms() and row.status == 'uploading':
            raise UploadGone('upload session expired')
        return UploadStatus(
            upload_id=row.id,
            parent_id=row.parent_id,
            name=row.name,
            size=row.size,
            chunk_size=row.chunk_size,
            total_chunks=row.total_chunks,
            received_chunks=_decode_mask(row.received_mask, row.total_chunks),
            status=row.status,
        )

    def put_chunk(self, upload_id: str, idx: int, data: bytes) -> None:
        with self._lock_for(upload_id):
            row = db.session.execute(
                text('SELECT * FROM drive_uploads WHERE id = :id'),
                {'id': upload_id},
            ).first()
            if row is None:
                raise UploadNotFound('upload not found')
            if row.status != 'uploading':
                raise UploadInvalid(f'upload status is {row.status}')
            if row.expires_at < utc_now_ms():
                raise UploadGone('upload session expired')
            if idx < 0 or idx >= row.total_chunks:
                raise UploadInvalid('chunk index out of range')

            expected = row.chunk_size
            if idx == row.total_chunks - 1:
                expected = row.size - row.chunk_size * (row.total_chunks - 1)
            if len(data) != expected:
                raise UploadInvalid(
                    f'chunk size mismatch: got {len(data)} expected {expected}'
                )

            os.makedirs(self._chunks_dir(upload_id), exist_ok=True)
            tmp = self._chunk_path(upload_id, idx) + '.part'
            with open(tmp, 'wb') as f:
                f.write(data)
            os.replace(tmp, self._chunk_path(upload_id, idx))

            mask = bytearray(row.received_mask)
            mask[idx // 8] |= 1 << (idx % 8)
            try:
                db.session.execute(
                    text(
                        'UPDATE drive_uploads SET received_mask = :m, updated_at = :now '
                        "WHERE id = :id AND status = 'uploading'"
                    ),
                    {'m': bytes(mask), 'now': utc_now_ms(), 'id': upload_id},
                )
                db.session.commit()
            except Exception:
                db.session.rollback()
                raise

    def complete(self, upload_id: str, on_collision: str = 'ask') -> 'object':
        # Atomic uploading -> assembling flip
        try:
            res = db.session.execute(
                text(
                    "UPDATE drive_uploads SET status = 'assembling', updated_at = :now "
                    "WHERE id = :id AND status = 'uploading'"
                ),
                {'now': utc_now_ms(), 'id': upload_id},
            )
            db.session.commit()
        except Exception:
            db.session.rollback()
            raise
        if res.rowcount == 0:
            row = db.session.execute(
                text('SELECT status FROM drive_uploads WHERE id = :id'),
                {'id': upload_id},
            ).first()
            if row is None:
                raise UploadNotFound('upload not found')
            raise UploadInvalid(f'upload not in uploading state (was {row.status})')

        try:
            return self._assemble(upload_id, on_collision)
        except Exception:
            try:
                db.session.execute(
                    text(
                        "UPDATE drive_uploads SET status = 'failed', updated_at = :now "
                        'WHERE id = :id'
                    ),
                    {'now': utc_now_ms(), 'id': upload_id},
                )
                db.session.commit()
            except Exception:
                db.session.rollback()
            raise

    def _assemble(self, upload_id: str, on_collision: str):
        row = db.session.execute(
            text('SELECT * FROM drive_uploads WHERE id = :id'),
            {'id': upload_id},
        ).first()
        if row is None:
            raise UploadNotFound('upload not found')

        # Verify all chunks present.
        for i in range(row.total_chunks):
            if not (row.received_mask[i // 8] & (1 << (i % 8))):
                raise UploadInvalid(f'missing chunk {i}')

        name = row.name
        parent_id = row.parent_id

        # Pre-collision check.
        sib = self.drive.find_active_sibling(parent_id, name)
        if sib is not None:
            if on_collision == 'skip':
                # Discard upload; return existing.
                self._cleanup_upload(upload_id)
                return sib
            if on_collision == 'rename':
                name = self.drive.auto_rename(parent_id, name)
            elif on_collision == 'overwrite':
                pass
            else:
                raise UploadCollision('name already exists in this folder')

        blob_name = new_blob_name(name)
        blob_rel = os.path.join('drive', blob_name)
        blob_abs = self.drive.blob_abs_path(blob_rel)

        os.makedirs(os.path.dirname(blob_abs), exist_ok=True)
        h = hashlib.sha256()
        tmp = blob_abs + '.part'
        try:
            with open(tmp, 'wb') as out:
                for i in range(row.total_chunks):
                    p = self._chunk_path(upload_id, i)
                    with open(p, 'rb') as fr:
                        while True:
                            buf = fr.read(64 * 1024)
                            if not buf:
                                break
                            out.write(buf)
                            h.update(buf)
            os.replace(tmp, blob_abs)
        except Exception:
            try:
                os.remove(tmp)
            except OSError:
                pass
            raise

        try:
            if sib is not None and on_collision == 'overwrite':
                node = self.drive.replace_file_node(
                    parent_id, name, blob_rel, h.hexdigest(), row.size
                )
            else:
                node = self.drive.create_file_node(
                    parent_id, name, blob_rel, h.hexdigest(), row.size
                )
        except DriveNameConflict:
            try:
                os.remove(blob_abs)
            except OSError:
                pass
            raise

        # Mark done + cleanup chunks.
        try:
            db.session.execute(
                text(
                    "UPDATE drive_uploads SET status = 'done', updated_at = :now "
                    'WHERE id = :id'
                ),
                {'now': utc_now_ms(), 'id': upload_id},
            )
            db.session.commit()
        except Exception:
            db.session.rollback()
        shutil.rmtree(self._chunks_dir(upload_id), ignore_errors=True)
        return node

    def cancel(self, upload_id: str) -> None:
        try:
            db.session.execute(
                text('DELETE FROM drive_uploads WHERE id = :id'),
                {'id': upload_id},
            )
            db.session.commit()
        except Exception:
            db.session.rollback()
            raise
        shutil.rmtree(self._chunks_dir(upload_id), ignore_errors=True)

    def _cleanup_upload(self, upload_id: str) -> None:
        try:
            db.session.execute(
                text('DELETE FROM drive_uploads WHERE id = :id'),
                {'id': upload_id},
            )
            db.session.commit()
        except Exception:
            db.session.rollback()
        shutil.rmtree(self._chunks_dir(upload_id), ignore_errors=True)

    # -- background -----------------------------------------------------------

    def purge_expired(self) -> int:
        rows = db.session.execute(
            text(
                'SELECT id FROM drive_uploads '
                'WHERE expires_at < :now '
                "  AND status IN ('uploading', 'failed')"
            ),
            {'now': utc_now_ms()},
        ).all()
        ids = [r.id for r in rows]
        for uid in ids:
            self._cleanup_upload(uid)
        return len(ids)
