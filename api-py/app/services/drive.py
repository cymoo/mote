"""Drive service — tree CRUD for the cloud-drive feature.

Translation of api-go/internal/services/drive.go. Public surface (function
names, return shapes, error sentinels) mirrors the Go service so behaviour
is byte-compatible.

Streaming-zip and thumbnail helpers live in :mod:`drive_zip` and
:mod:`drive_thumb`; this module focuses on tree CRUD and shared utilities.
"""
from __future__ import annotations

import os
import re
import secrets
import uuid
from dataclasses import dataclass
from typing import List, Optional

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from ..extension import db
from ..model import utc_now_ms

# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class DriveError(Exception):
    """Base class for drive service errors."""


class DriveNotFound(DriveError):
    pass


class DriveNameConflict(DriveError):
    pass


class DriveCycle(DriveError):
    pass


class DriveNotFolder(DriveError):
    pass


class DriveInvalidName(DriveError):
    pass


class DriveInvalidParent(DriveError):
    pass


class DriveNotImage(DriveError):
    pass


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

THUMB_WIDTH = 240
IMAGE_EXTS = {'.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff'}

_NAME_INVALID = re.compile(r'[/\\]')


def valid_name(name: str) -> None:
    n = name.strip()
    if not n or n in ('.', '..'):
        raise DriveInvalidName('invalid name')
    if _NAME_INVALID.search(n):
        raise DriveInvalidName('invalid name')
    if len(n) > 255:
        raise DriveInvalidName('invalid name')


def _like_escape(s: str) -> str:
    return s.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')


def _is_unique_err(err: Exception) -> bool:
    msg = str(getattr(err, 'orig', err)) if isinstance(err, IntegrityError) else str(err)
    return 'UNIQUE constraint failed' in msg or 'constraint failed: UNIQUE' in msg


def new_token(n_bytes: int) -> str:
    return secrets.token_hex(n_bytes)


def new_blob_name(original_name: str) -> str:
    ext = os.path.splitext(original_name)[1].lower()
    return uuid.uuid4().hex + ext


# ---------------------------------------------------------------------------
# Row containers (lightweight; we use raw SQL throughout)
# ---------------------------------------------------------------------------


@dataclass
class DriveNodeRow:
    id: int
    parent_id: Optional[int]
    type: str
    name: str
    blob_path: Optional[str]
    size: Optional[int]
    hash: Optional[str]
    deleted_at: Optional[int]
    delete_batch_id: Optional[str]
    created_at: int
    updated_at: int
    path: str = ''  # populated on search responses
    share_count: int = 0  # populated on listings

    @classmethod
    def from_row(cls, r) -> 'DriveNodeRow':
        return cls(
            id=r.id,
            parent_id=r.parent_id,
            type=r.type,
            name=r.name,
            blob_path=r.blob_path,
            size=r.size,
            hash=r.hash,
            deleted_at=r.deleted_at,
            delete_batch_id=r.delete_batch_id,
            created_at=r.created_at,
            updated_at=r.updated_at,
        )

    def ext(self) -> str:
        if self.type != 'file':
            return ''
        return os.path.splitext(self.name)[1].lower()

    def mime_type(self) -> str:
        if self.type != 'file':
            return ''
        import mimetypes

        mt = mimetypes.guess_type(self.name)[0]
        return mt or 'application/octet-stream'

    def to_dict(self) -> dict:
        d = {
            'id': self.id,
            'parent_id': self.parent_id,
            'type': self.type,
            'name': self.name,
            'size': self.size,
            'created_at': self.created_at,
            'updated_at': self.updated_at,
        }
        if self.deleted_at is not None:
            d['deleted_at'] = self.deleted_at
        if self.hash:
            d['hash'] = self.hash
        if self.path:
            d['path'] = self.path
        if self.share_count > 0:
            d['share_count'] = self.share_count
        if self.type == 'file':
            d['ext'] = self.ext()
            d['mime_type'] = self.mime_type()
        else:
            d['ext'] = None
            d['mime_type'] = None
        return d


@dataclass
class DescendantRow:
    id: int
    type: str
    name: str
    blob_path: Optional[str]
    rel_path: str


# ---------------------------------------------------------------------------
# DriveService
# ---------------------------------------------------------------------------


class DriveService:
    """Tree CRUD for the drive feature.

    Stateless aside from `base_path`. Use one instance per Flask app
    (constructed in app.py with the app's UPLOAD_PATH).
    """

    def __init__(self, base_path: str):
        self.base_path = base_path
        os.makedirs(os.path.join(base_path, 'drive'), exist_ok=True)
        os.makedirs(os.path.join(base_path, 'drive', '_chunks'), exist_ok=True)

    # -- paths -----------------------------------------------------------------

    def blob_abs_path(self, rel: str) -> str:
        return os.path.join(self.base_path, rel)

    # -- read ------------------------------------------------------------------

    def find_by_id(self, node_id: int) -> DriveNodeRow:
        row = db.session.execute(
            text('SELECT * FROM drive_nodes WHERE id = :id'),
            {'id': node_id},
        ).first()
        if row is None:
            raise DriveNotFound('drive node not found')
        return DriveNodeRow.from_row(row)

    def list(
        self,
        parent_id: Optional[int],
        query: Optional[str],
        order_by: str = '',
        sort: str = '',
    ) -> List[DriveNodeRow]:
        has_query = bool(query and query.strip())

        params: dict = {}
        if has_query:
            pattern = '%' + _like_escape(query.strip().lower()) + '%'
            where = "deleted_at IS NULL AND LOWER(name) LIKE :pat ESCAPE '\\'"
            params['pat'] = pattern
        elif parent_id is None:
            where = 'parent_id IS NULL AND deleted_at IS NULL'
        else:
            self._require_active_folder(parent_id)
            where = 'parent_id = :pid AND deleted_at IS NULL'
            params['pid'] = parent_id

        col = 'LOWER(name)'
        if order_by == 'size':
            col = 'size'
        elif order_by == 'updated_at':
            col = 'updated_at'
        elif order_by == 'created_at':
            col = 'created_at'

        direction = 'DESC' if (sort or '').lower() == 'desc' else 'ASC'

        sql = (
            f'SELECT * FROM drive_nodes WHERE {where} '
            f"ORDER BY CASE WHEN type = 'folder' THEN 0 ELSE 1 END, "
            f'{col} {direction}, id ASC'
        )
        rows = db.session.execute(text(sql), params).all()
        out = [DriveNodeRow.from_row(r) for r in rows]
        if has_query and out:
            self._populate_paths(out)
        if out:
            self._populate_share_counts(out)
        return out

    def _populate_paths(self, nodes: List[DriveNodeRow]) -> None:
        cache: dict[int, str] = {}
        for n in nodes:
            if n.parent_id is None:
                continue
            if n.parent_id in cache:
                n.path = cache[n.parent_id]
                continue
            bcs = self.breadcrumbs(n.parent_id)
            p = '/'.join(bc['name'] for bc in bcs)
            cache[n.parent_id] = p
            n.path = p

    def _populate_share_counts(self, nodes: List[DriveNodeRow]) -> None:
        ids = [n.id for n in nodes if n.type == 'file']
        if not ids:
            return
        placeholders = ','.join(f':id{i}' for i in range(len(ids)))
        params: dict = {f'id{i}': v for i, v in enumerate(ids)}
        params['now'] = utc_now_ms()
        rows = db.session.execute(
            text(
                f'SELECT node_id, COUNT(*) AS c FROM drive_shares '
                f'WHERE node_id IN ({placeholders}) '
                f'AND (expires_at IS NULL OR expires_at > :now) '
                f'GROUP BY node_id'
            ),
            params,
        ).all()
        counts = {r.node_id: r.c for r in rows}
        for n in nodes:
            if n.id in counts:
                n.share_count = counts[n.id]

    def list_trash(self) -> List[DriveNodeRow]:
        sql = (
            'SELECT n.* FROM drive_nodes n '
            'WHERE n.deleted_at IS NOT NULL '
            '  AND ('
            '    n.parent_id IS NULL '
            '    OR NOT EXISTS ('
            '      SELECT 1 FROM drive_nodes p '
            '      WHERE p.id = n.parent_id '
            '        AND p.deleted_at IS NOT NULL '
            '        AND p.delete_batch_id = n.delete_batch_id '
            '    ) '
            '  ) '
            'ORDER BY n.deleted_at DESC, n.id DESC'
        )
        rows = db.session.execute(text(sql)).all()
        return [DriveNodeRow.from_row(r) for r in rows]

    def breadcrumbs(self, node_id: int) -> List[dict]:
        sql = (
            'WITH RECURSIVE chain(id, name, parent_id, depth) AS ('
            '  SELECT id, name, parent_id, 0 FROM drive_nodes WHERE id = :id '
            '  UNION ALL '
            '  SELECT n.id, n.name, n.parent_id, c.depth + 1 '
            '  FROM drive_nodes n JOIN chain c ON n.id = c.parent_id'
            ') SELECT id, name FROM chain ORDER BY depth DESC'
        )
        rows = db.session.execute(text(sql), {'id': node_id}).all()
        return [{'id': r.id, 'name': r.name} for r in rows]

    # -- write -----------------------------------------------------------------

    def create_folder(self, parent_id: Optional[int], name: str) -> DriveNodeRow:
        valid_name(name)
        if parent_id is not None:
            self._require_active_folder(parent_id)
        now = utc_now_ms()
        try:
            res = db.session.execute(
                text(
                    'INSERT INTO drive_nodes (parent_id, type, name, created_at, updated_at) '
                    "VALUES (:pid, 'folder', :name, :now, :now) RETURNING id"
                ),
                {'pid': parent_id, 'name': name, 'now': now},
            )
            new_id = res.scalar_one()
            db.session.commit()
        except IntegrityError as err:
            db.session.rollback()
            if _is_unique_err(err):
                raise DriveNameConflict('name already exists in this folder')
            raise
        return self.find_by_id(new_id)

    def rename(self, node_id: int, new_name: str) -> None:
        valid_name(new_name)
        now = utc_now_ms()
        try:
            res = db.session.execute(
                text(
                    'UPDATE drive_nodes SET name = :name, updated_at = :now '
                    'WHERE id = :id AND deleted_at IS NULL'
                ),
                {'name': new_name, 'now': now, 'id': node_id},
            )
            db.session.commit()
        except IntegrityError as err:
            db.session.rollback()
            if _is_unique_err(err):
                raise DriveNameConflict('name already exists in this folder')
            raise
        if res.rowcount == 0:
            raise DriveNotFound('drive node not found')

    def move(self, ids: List[int], new_parent_id: Optional[int]) -> None:
        if not ids:
            return
        if new_parent_id is not None:
            row = db.session.execute(
                text('SELECT type, deleted_at FROM drive_nodes WHERE id = :id'),
                {'id': new_parent_id},
            ).first()
            if row is None or row.deleted_at is not None:
                raise DriveInvalidParent('invalid parent folder')
            if row.type != 'folder':
                raise DriveNotFolder('parent must be a folder')

        now = utc_now_ms()
        try:
            for nid in ids:
                if new_parent_id is not None and new_parent_id == nid:
                    raise DriveCycle('cannot move folder into its own descendant')
                if new_parent_id is not None:
                    hit = db.session.execute(
                        text(
                            'WITH RECURSIVE descendants(id) AS ('
                            '  SELECT id FROM drive_nodes WHERE id = :nid '
                            '  UNION ALL '
                            '  SELECT n.id FROM drive_nodes n JOIN descendants d ON n.parent_id = d.id'
                            ') SELECT EXISTS(SELECT 1 FROM descendants WHERE id = :np)'
                        ),
                        {'nid': nid, 'np': new_parent_id},
                    ).scalar()
                    if hit:
                        raise DriveCycle('cannot move folder into its own descendant')
                db.session.execute(
                    text(
                        'UPDATE drive_nodes SET parent_id = :pid, updated_at = :now '
                        'WHERE id = :id AND deleted_at IS NULL'
                    ),
                    {'pid': new_parent_id, 'now': now, 'id': nid},
                )
            db.session.commit()
        except IntegrityError as err:
            db.session.rollback()
            if _is_unique_err(err):
                raise DriveNameConflict('name already exists in this folder')
            raise
        except Exception:
            db.session.rollback()
            raise

    def soft_delete(self, ids: List[int]) -> None:
        if not ids:
            return
        batch = new_token(16)
        now = utc_now_ms()
        try:
            for nid in ids:
                db.session.execute(
                    text(
                        'WITH RECURSIVE subtree(id) AS ('
                        '  SELECT id FROM drive_nodes WHERE id = :id AND deleted_at IS NULL '
                        '  UNION ALL '
                        '  SELECT n.id FROM drive_nodes n JOIN subtree s ON n.parent_id = s.id '
                        '  WHERE n.deleted_at IS NULL'
                        ') UPDATE drive_nodes '
                        'SET deleted_at = :now, delete_batch_id = :batch, updated_at = :now '
                        'WHERE id IN (SELECT id FROM subtree)'
                    ),
                    {'id': nid, 'now': now, 'batch': batch},
                )
            db.session.commit()
        except Exception:
            db.session.rollback()
            raise

    def restore(self, node_id: int) -> None:
        n = self.find_by_id(node_id)
        if n.deleted_at is None:
            return
        if not n.delete_batch_id:
            db.session.execute(
                text(
                    'UPDATE drive_nodes SET deleted_at = NULL, delete_batch_id = NULL '
                    'WHERE id = :id'
                ),
                {'id': node_id},
            )
            db.session.commit()
            return

        try:
            roots = db.session.execute(
                text(
                    'SELECT * FROM drive_nodes n '
                    'WHERE n.delete_batch_id = :batch '
                    '  AND ('
                    '    n.parent_id IS NULL '
                    '    OR NOT EXISTS ('
                    '      SELECT 1 FROM drive_nodes p '
                    '      WHERE p.id = n.parent_id '
                    '        AND p.delete_batch_id = n.delete_batch_id'
                    '    )'
                    '  )'
                ),
                {'batch': n.delete_batch_id},
            ).all()
            for r in roots:
                hit = db.session.execute(
                    text(
                        'SELECT EXISTS('
                        '  SELECT 1 FROM drive_nodes '
                        '  WHERE COALESCE(parent_id, 0) = COALESCE(:pid, 0) '
                        '    AND LOWER(name) = LOWER(:name) '
                        '    AND deleted_at IS NULL'
                        ')'
                    ),
                    {'pid': r.parent_id, 'name': r.name},
                ).scalar()
                if hit:
                    raise DriveNameConflict('name already exists in this folder')
            db.session.execute(
                text(
                    'UPDATE drive_nodes SET deleted_at = NULL, delete_batch_id = NULL '
                    'WHERE delete_batch_id = :batch'
                ),
                {'batch': n.delete_batch_id},
            )
            db.session.commit()
        except Exception:
            db.session.rollback()
            raise

    def purge(self, ids: List[int]) -> None:
        for nid in ids:
            self._purge_one(nid)

    def _purge_one(self, node_id: int) -> None:
        rows = db.session.execute(
            text(
                'WITH RECURSIVE subtree(id) AS ('
                '  SELECT id FROM drive_nodes WHERE id = :id '
                '  UNION ALL '
                '  SELECT n.id FROM drive_nodes n JOIN subtree s ON n.parent_id = s.id'
                ') SELECT n.id, n.blob_path FROM drive_nodes n '
                'WHERE n.id IN (SELECT id FROM subtree)'
            ),
            {'id': node_id},
        ).all()
        if not rows:
            raise DriveNotFound('drive node not found')

        try:
            db.session.execute(
                text('DELETE FROM drive_nodes WHERE id = :id'), {'id': node_id}
            )
            db.session.commit()
        except Exception:
            db.session.rollback()
            raise
        for r in rows:
            if r.blob_path:
                try:
                    os.remove(self.blob_abs_path(r.blob_path))
                except OSError:
                    pass
                _purge_thumb(self.base_path, r.blob_path)

    # -- file-node helpers (used by upload service) ----------------------------

    def create_file_node(
        self,
        parent_id: Optional[int],
        name: str,
        blob_path: str,
        hash_hex: str,
        size: int,
    ) -> DriveNodeRow:
        valid_name(name)
        if parent_id is not None:
            self._require_active_folder(parent_id)
        now = utc_now_ms()
        try:
            new_id = db.session.execute(
                text(
                    'INSERT INTO drive_nodes '
                    '(parent_id, type, name, blob_path, size, hash, created_at, updated_at) '
                    "VALUES (:pid, 'file', :name, :bp, :size, NULLIF(:hash, ''), :now, :now) "
                    'RETURNING id'
                ),
                {
                    'pid': parent_id,
                    'name': name,
                    'bp': blob_path,
                    'size': size,
                    'hash': hash_hex,
                    'now': now,
                },
            ).scalar_one()
            db.session.commit()
        except IntegrityError as err:
            db.session.rollback()
            if _is_unique_err(err):
                raise DriveNameConflict('name already exists in this folder')
            raise
        return self.find_by_id(new_id)

    def replace_file_node(
        self,
        parent_id: Optional[int],
        name: str,
        blob_path: str,
        hash_hex: str,
        size: int,
    ) -> DriveNodeRow:
        valid_name(name)
        existing = db.session.execute(
            text(
                'SELECT * FROM drive_nodes '
                'WHERE COALESCE(parent_id, 0) = COALESCE(:pid, 0) '
                '  AND LOWER(name) = :name '
                '  AND deleted_at IS NULL'
            ),
            {'pid': parent_id, 'name': name.lower()},
        ).first()
        now = utc_now_ms()
        if existing is None or existing.type != 'file':
            try:
                new_id = db.session.execute(
                    text(
                        'INSERT INTO drive_nodes '
                        '(parent_id, type, name, blob_path, size, hash, created_at, updated_at) '
                        "VALUES (:pid, 'file', :name, :bp, :size, NULLIF(:hash, ''), :now, :now) "
                        'RETURNING id'
                    ),
                    {
                        'pid': parent_id,
                        'name': name,
                        'bp': blob_path,
                        'size': size,
                        'hash': hash_hex,
                        'now': now,
                    },
                ).scalar_one()
                db.session.commit()
            except IntegrityError as err:
                db.session.rollback()
                if _is_unique_err(err):
                    raise DriveNameConflict('name already exists in this folder')
                raise
            return self.find_by_id(new_id)

        old_blob = existing.blob_path or ''
        try:
            db.session.execute(
                text(
                    'UPDATE drive_nodes '
                    "SET blob_path = :bp, size = :size, hash = NULLIF(:hash, ''), "
                    'updated_at = :now '
                    'WHERE id = :id'
                ),
                {
                    'bp': blob_path,
                    'size': size,
                    'hash': hash_hex,
                    'now': now,
                    'id': existing.id,
                },
            )
            db.session.commit()
        except Exception:
            db.session.rollback()
            raise

        if old_blob and old_blob != blob_path:
            try:
                os.remove(self.blob_abs_path(old_blob))
            except OSError:
                pass
            _purge_thumb(self.base_path, old_blob)
        return self.find_by_id(existing.id)

    def find_active_sibling(
        self, parent_id: Optional[int], name: str
    ) -> Optional[DriveNodeRow]:
        row = db.session.execute(
            text(
                'SELECT * FROM drive_nodes '
                'WHERE COALESCE(parent_id, 0) = COALESCE(:pid, 0) '
                '  AND LOWER(name) = :name '
                '  AND deleted_at IS NULL'
            ),
            {'pid': parent_id, 'name': name.lower()},
        ).first()
        return DriveNodeRow.from_row(row) if row else None

    def auto_rename(self, parent_id: Optional[int], name: str) -> str:
        sib = self.find_active_sibling(parent_id, name)
        if sib is None:
            return name
        ext = os.path.splitext(name)[1]
        stem = name[: len(name) - len(ext)]

        prefix = _like_escape(stem) + ' (%'
        suffix = '%)' + _like_escape(ext)
        rows = db.session.execute(
            text(
                'SELECT name FROM drive_nodes '
                'WHERE COALESCE(parent_id, 0) = COALESCE(:pid, 0) '
                '  AND deleted_at IS NULL '
                "  AND name LIKE :prefix ESCAPE '\\' "
                "  AND name LIKE :suffix ESCAPE '\\'"
            ),
            {'pid': parent_id, 'prefix': prefix, 'suffix': suffix},
        ).all()
        max_n = 0
        for r in rows:
            mid = r.name
            if ext:
                if not mid.endswith(ext):
                    continue
                mid = mid[: -len(ext)]
            i = mid.rfind(' (')
            if i < 0:
                continue
            num = mid[i + 2 :]
            if not num.endswith(')'):
                continue
            num = num[:-1]
            try:
                n = int(num)
                if n > max_n:
                    max_n = n
            except ValueError:
                continue
        return f'{stem} ({max_n + 1}){ext}'

    def _require_active_folder(self, node_id: int) -> DriveNodeRow:
        n = self.find_by_id(node_id)
        if n.deleted_at is not None:
            raise DriveNotFound('drive node not found')
        if n.type != 'folder':
            raise DriveNotFolder('parent must be a folder')
        return n

    # -- descendants / zip ----------------------------------------------------

    def collect_descendants(self, root_id: int) -> List[DescendantRow]:
        rows = db.session.execute(
            text(
                'WITH RECURSIVE subtree(id, type, name, blob_path, rel_path) AS ('
                '  SELECT id, type, name, blob_path, name AS rel_path '
                '  FROM drive_nodes WHERE id = :id AND deleted_at IS NULL '
                '  UNION ALL '
                "  SELECT n.id, n.type, n.name, n.blob_path, s.rel_path || '/' || n.name "
                '  FROM drive_nodes n '
                '  JOIN subtree s ON n.parent_id = s.id '
                '  WHERE n.deleted_at IS NULL'
                ') SELECT id, type, name, blob_path, rel_path FROM subtree'
            ),
            {'id': root_id},
        ).all()
        return [
            DescendantRow(
                id=r.id,
                type=r.type,
                name=r.name,
                blob_path=r.blob_path,
                rel_path=r.rel_path,
            )
            for r in rows
        ]

    # -- background helpers ---------------------------------------------------

    def purge_old_trash(self, older_than_ms: int) -> int:
        """Hard-delete soft-deleted nodes whose deleted_at is older than the
        given epoch-ms threshold. Returns the count of root rows purged.
        """
        rows = db.session.execute(
            text(
                'SELECT id FROM drive_nodes '
                'WHERE deleted_at IS NOT NULL '
                '  AND deleted_at < :t '
                '  AND ('
                '    parent_id IS NULL '
                '    OR NOT EXISTS ('
                '      SELECT 1 FROM drive_nodes p '
                '      WHERE p.id = parent_id '
                '        AND p.deleted_at IS NOT NULL '
                '        AND p.delete_batch_id = drive_nodes.delete_batch_id'
                '    )'
                '  )'
            ),
            {'t': older_than_ms},
        ).all()
        ids = [r.id for r in rows]
        if ids:
            self.purge(ids)
        return len(ids)


# ---------------------------------------------------------------------------
# Force-attachment rule (mirrors Go mustForceAttachment)
# ---------------------------------------------------------------------------

_UNSAFE_EXTS = {'html', 'htm', 'svg', 'xhtml', 'xml', 'js', 'mjs'}


def must_force_attachment(mime_type: str, ext: str) -> bool:
    mt = (mime_type or '').lower()
    e = (ext or '').lower().lstrip('.')
    if e in _UNSAFE_EXTS:
        return True
    if mt.startswith('text/html') or 'javascript' in mt or mt.startswith('image/svg'):
        return True
    if mt == '' or mt == 'application/octet-stream':
        return True
    return False


def _purge_thumb(base_path: str, blob_path: str) -> None:
    """Deferred import wrapper to avoid a circular import with drive_thumb."""
    from .drive_thumb import purge_thumb

    purge_thumb(base_path, blob_path)
