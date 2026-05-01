"""Drive share service — public link sharing with optional password/expiry.

Translation of api-go/internal/services/drive_share.go.
"""
from __future__ import annotations

import hashlib
import hmac
import mimetypes
import os
import secrets
from dataclasses import dataclass
from typing import List, Optional

import bcrypt
from sqlalchemy import text

from ..extension import db
from ..model import utc_now_ms
from .drive import DriveError, DriveNotFound, DriveService


SHARE_TOKEN_BYTES = 32
SHARE_TOKEN_PREFIX_LEN = 8
SHARE_PASSWORD_COOKIE_PREFIX = 'drive_share_pw_'

_MIME_STATIC: dict[str, str] = {
    '.mp4': 'video/mp4', '.m4v': 'video/x-m4v', '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska',
    '.wmv': 'video/x-ms-wmv', '.webm': 'video/webm',
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
    '.flac': 'audio/flac', '.wav': 'audio/wav',
    '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
}


def _mime_for_name(node_type: str, name: str) -> str:
    """Compute MIME type from node type and filename. Mirrors DriveNodeRow.mime_type()."""
    if node_type != 'file':
        return ''
    ext = os.path.splitext(name)[1].lower()
    if ext in _MIME_STATIC:
        return _MIME_STATIC[ext]
    return mimetypes.guess_type(name)[0] or 'application/octet-stream'


class ShareNotFound(DriveError):
    pass


class ShareExpired(DriveError):
    pass


class ShareUnauthorized(DriveError):
    pass


class ShareInvalidNode(DriveError):
    """Raised when attempting to share a non-file node (e.g. folder)."""


def _hash_token(token: str) -> tuple[str, str]:
    h = hashlib.sha256(token.encode()).hexdigest()
    return h, h[:SHARE_TOKEN_PREFIX_LEN]


def share_password_cookie_name(token: str) -> str:
    return SHARE_PASSWORD_COOKIE_PREFIX + token[:8].replace('-', '_')


@dataclass
class ShareRow:
    id: int
    node_id: int
    token_hash: str
    token_prefix: str
    stored_token: Optional[str]
    password_hash: Optional[str]
    expires_at: Optional[int]
    created_at: int

    @classmethod
    def from_row(cls, r) -> 'ShareRow':
        return cls(
            id=r.id,
            node_id=r.node_id,
            token_hash=r.token_hash,
            token_prefix=r.token_prefix,
            stored_token=getattr(r, 'token', None),
            password_hash=r.password_hash,
            expires_at=r.expires_at,
            created_at=r.created_at,
        )


@dataclass
class ShareDTO:
    id: int
    node_id: int
    token: str  # only populated on create
    url: str  # only populated on create
    has_password: bool
    expires_at: Optional[int]
    created_at: int

    def to_dict(self) -> dict:
        d = {
            'id': self.id,
            'node_id': self.node_id,
            'has_password': self.has_password,
            'created_at': self.created_at,
        }
        if self.token:
            d['token'] = self.token
        if self.url:
            d['url'] = self.url
        if self.expires_at is not None:
            d['expires_at'] = self.expires_at
        return d


class DriveShareService:
    def __init__(self, drive: DriveService):
        self.drive = drive

    # -- create --------------------------------------------------------------

    def create(
        self,
        node_id: int,
        password: Optional[str],
        expires_at: Optional[int],
    ) -> tuple[ShareRow, str]:
        # Verify node exists, isn't deleted, and is a file (parity with
        # api-go: folder shares are not allowed).
        n = self.drive.find_by_id(node_id)
        if n.deleted_at is not None:
            raise DriveNotFound('drive node not found')
        if n.type != 'file':
            raise ShareInvalidNode('only files can be shared')

        token = secrets.token_urlsafe(SHARE_TOKEN_BYTES).rstrip('=')
        token_hash, prefix = _hash_token(token)
        pw_hash = None
        if password:
            pw_hash = bcrypt.hashpw(
                password.encode(), bcrypt.gensalt()
            ).decode()

        now = utc_now_ms()
        try:
            new_id = db.session.execute(
                text(
                    'INSERT INTO drive_shares '
                    '(node_id, token_hash, token_prefix, token, password_hash, expires_at, created_at) '
                    'VALUES (:nid, :h, :p, :token, :pw, :exp, :now) RETURNING id'
                ),
                {
                    'nid': node_id,
                    'h': token_hash,
                    'p': prefix,
                    'token': token,
                    'pw': pw_hash,
                    'exp': expires_at if expires_at else None,
                    'now': now,
                },
            ).scalar_one()
            db.session.commit()
        except Exception:
            db.session.rollback()
            raise
        row = ShareRow(
            id=new_id,
            node_id=node_id,
            token_hash=token_hash,
            token_prefix=prefix,
            stored_token=token,
            password_hash=pw_hash,
            expires_at=expires_at if expires_at else None,
            created_at=now,
        )
        return row, token

    # -- read ----------------------------------------------------------------

    def list_by_node(self, node_id: int) -> List[ShareRow]:
        rows = db.session.execute(
            text(
                'SELECT * FROM drive_shares WHERE node_id = :nid '
                'ORDER BY created_at DESC'
            ),
            {'nid': node_id},
        ).all()
        return [ShareRow.from_row(r) for r in rows]

    def list_all(self, include_expired: bool) -> List[dict]:
        # Mirrors api-go ListAll: shares joined with node name/size/parent_id,
        # excludes shares whose underlying file has been soft-deleted, and
        # denormalises the parent folder path via Breadcrumbs.
        q = (
            'SELECT s.*, n.name AS node_name, '
            '  COALESCE(n.size, 0) AS node_size, '
            '  n.parent_id AS node_parent_id, '
            '  n.type AS node_type '
            'FROM drive_shares s '
            'JOIN drive_nodes n ON n.id = s.node_id '
            'WHERE n.deleted_at IS NULL'
        )
        params: dict = {}
        if not include_expired:
            q += ' AND (s.expires_at IS NULL OR s.expires_at > :now)'
            params['now'] = utc_now_ms()
        q += ' ORDER BY s.created_at DESC'
        rows = db.session.execute(text(q), params).all()

        path_cache: dict[int, str] = {}
        out: list[dict] = []
        for r in rows:
            path = ''
            pid = r.node_parent_id
            if pid is not None:
                if pid in path_cache:
                    path = path_cache[pid]
                else:
                    bcs = self.drive.breadcrumbs(pid)
                    path = '/'.join(bc['name'] for bc in bcs)
                    path_cache[pid] = path
            out.append(
                {
                    'id': r.id,
                    'node_id': r.node_id,
                    'parent_id': pid,
                    'has_password': r.password_hash is not None,
                    'expires_at': r.expires_at,
                    'created_at': r.created_at,
                    'name': r.node_name,
                    'size': r.node_size,
                    'path': path,
                    'token': r.token,
                    'node_type': r.node_type,
                    'mime_type': _mime_for_name(r.node_type, r.node_name),
                }
            )
        return out

    # -- delete --------------------------------------------------------------

    def revoke(self, share_id: int) -> None:
        try:
            res = db.session.execute(
                text('DELETE FROM drive_shares WHERE id = :id'),
                {'id': share_id},
            )
            db.session.commit()
        except Exception:
            db.session.rollback()
            raise
        if res.rowcount == 0:
            raise ShareNotFound('share not found')

    def purge_expired(self) -> int:
        try:
            res = db.session.execute(
                text(
                    'DELETE FROM drive_shares '
                    'WHERE expires_at IS NOT NULL AND expires_at <= :now'
                ),
                {'now': utc_now_ms()},
            )
            db.session.commit()
        except Exception:
            db.session.rollback()
            raise
        return res.rowcount or 0

    # -- resolve (anonymous) -------------------------------------------------

    def resolve(self, token: str) -> tuple[ShareRow, 'object']:
        token_hash, prefix = _hash_token(token)
        rows = db.session.execute(
            text(
                'SELECT * FROM drive_shares WHERE token_prefix = :p'
            ),
            {'p': prefix},
        ).all()
        match = None
        for r in rows:
            if hmac.compare_digest(r.token_hash, token_hash):
                match = r
                break
        if match is None:
            raise ShareNotFound('share not found')
        share = ShareRow.from_row(match)
        if share.expires_at is not None and share.expires_at <= utc_now_ms():
            raise ShareExpired('share has expired')
        node = self.drive.find_by_id(share.node_id)
        if node.deleted_at is not None or node.type != 'file':
            raise ShareNotFound('share not found')
        return share, node

    def verify_password(self, share: ShareRow, password: str) -> bool:
        if not share.password_hash:
            return True
        try:
            return bcrypt.checkpw(password.encode(), share.password_hash.encode())
        except ValueError:
            return False
