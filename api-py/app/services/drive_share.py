"""Drive share service — public link sharing with optional password/expiry.

Translation of api-go/internal/services/drive_share.go.
"""
from __future__ import annotations

import hashlib
import hmac
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


class ShareNotFound(DriveError):
    pass


class ShareExpired(DriveError):
    pass


class ShareUnauthorized(DriveError):
    pass


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
        # Verify node exists and isn't deleted.
        n = self.drive.find_by_id(node_id)
        if n.deleted_at is not None:
            raise DriveNotFound('drive node not found')

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
                    '(node_id, token_hash, token_prefix, password_hash, expires_at, created_at) '
                    'VALUES (:nid, :h, :p, :pw, :exp, :now) RETURNING id'
                ),
                {
                    'nid': node_id,
                    'h': token_hash,
                    'p': prefix,
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
        if include_expired:
            where = '1=1'
        else:
            where = '(s.expires_at IS NULL OR s.expires_at > :now)'
        rows = db.session.execute(
            text(
                f'SELECT s.*, n.name AS node_name, n.type AS node_type, '
                f'  n.size AS node_size, n.deleted_at AS node_deleted_at '
                f'FROM drive_shares s '
                f'JOIN drive_nodes n ON n.id = s.node_id '
                f'WHERE {where} '
                f'ORDER BY s.created_at DESC'
            ),
            {'now': utc_now_ms()},
        ).all()
        out = []
        for r in rows:
            out.append(
                {
                    'id': r.id,
                    'node_id': r.node_id,
                    'node_name': r.node_name,
                    'node_type': r.node_type,
                    'node_size': r.node_size,
                    'node_deleted': r.node_deleted_at is not None,
                    'has_password': r.password_hash is not None,
                    'expires_at': r.expires_at,
                    'created_at': r.created_at,
                    'expired': r.expires_at is not None
                    and r.expires_at <= utc_now_ms(),
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
        if node.deleted_at is not None:
            raise DriveNotFound('shared item is no longer available')
        return share, node

    def verify_password(self, share: ShareRow, password: str) -> bool:
        if not share.password_hash:
            return True
        try:
            return bcrypt.checkpw(password.encode(), share.password_hash.encode())
        except ValueError:
            return False
