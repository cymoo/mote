from sqlalchemy import CheckConstraint, ForeignKey, Index, text

from ..extension import db


class DriveNode(db.Model):
    __tablename__ = 'drive_nodes'

    id = db.Column(db.Integer, primary_key=True, nullable=False)
    parent_id = db.Column(
        db.Integer,
        ForeignKey('drive_nodes.id', ondelete='CASCADE'),
        nullable=True,
    )
    type = db.Column(db.Text, nullable=False)
    name = db.Column(db.Text, nullable=False)
    blob_path = db.Column(db.Text, nullable=True)
    size = db.Column(db.BigInteger, nullable=True)
    hash = db.Column(db.Text, nullable=True)
    # NULL = not starred; epoch-ms when starred (doubles as sort key).
    starred_at = db.Column(db.BigInteger, nullable=True)
    deleted_at = db.Column(db.BigInteger, nullable=True)
    delete_batch_id = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.BigInteger, nullable=False)
    updated_at = db.Column(db.BigInteger, nullable=False)

    __table_args__ = (
        CheckConstraint("type IN ('folder', 'file')", name='ck_drive_nodes_type'),
        CheckConstraint(
            "(type = 'folder' AND blob_path IS NULL AND size IS NULL)"
            " OR (type = 'file' AND blob_path IS NOT NULL AND size IS NOT NULL)",
            name='ck_drive_nodes_shape',
        ),
        Index(
            'drive_nodes_unique_active',
            text('COALESCE(parent_id, 0)'),
            text('LOWER(name)'),
            unique=True,
            sqlite_where=text('deleted_at IS NULL'),
        ),
        Index('drive_nodes_parent', 'parent_id', 'deleted_at'),
        Index('drive_nodes_deleted', 'deleted_at'),
        Index('drive_nodes_name', text('LOWER(name)')),
        Index('drive_nodes_delete_batch', 'delete_batch_id'),
        # Dedup lookups (find_reusable_blob) filter by content hash.
        Index('drive_nodes_hash', 'hash', sqlite_where=text('hash IS NOT NULL')),
        # Blob refcount checks (remove_blob_if_orphan / purge) and
        # physical-usage stats filter/group by blob_path.
        Index(
            'drive_nodes_blob_path',
            'blob_path',
            sqlite_where=text('blob_path IS NOT NULL'),
        ),
        Index(
            'drive_nodes_starred',
            'starred_at',
            sqlite_where=text('starred_at IS NOT NULL'),
        ),
    )


class DriveUpload(db.Model):
    __tablename__ = 'drive_uploads'

    id = db.Column(db.Text, primary_key=True, nullable=False)
    parent_id = db.Column(
        db.Integer,
        ForeignKey('drive_nodes.id', ondelete='SET NULL'),
        nullable=True,
    )
    name = db.Column(db.Text, nullable=False)
    size = db.Column(db.BigInteger, nullable=False)
    chunk_size = db.Column(db.BigInteger, nullable=False)
    total_chunks = db.Column(db.Integer, nullable=False)
    received_mask = db.Column(db.LargeBinary, nullable=False)
    status = db.Column(db.Text, nullable=False)
    expires_at = db.Column(db.BigInteger, nullable=False)
    created_at = db.Column(db.BigInteger, nullable=False)
    updated_at = db.Column(db.BigInteger, nullable=False)

    __table_args__ = (
        CheckConstraint(
            "status IN ('uploading', 'assembling', 'done', 'failed')",
            name='ck_drive_uploads_status',
        ),
        Index('drive_uploads_expires', 'expires_at'),
    )


class DriveShare(db.Model):
    __tablename__ = 'drive_shares'

    id = db.Column(db.Integer, primary_key=True, nullable=False)
    node_id = db.Column(
        db.Integer,
        ForeignKey('drive_nodes.id', ondelete='CASCADE'),
        nullable=False,
    )
    token_hash = db.Column(db.Text, nullable=False, unique=True)
    token_prefix = db.Column(db.Text, nullable=False)
    token = db.Column(db.Text, nullable=True)
    password_hash = db.Column(db.Text, nullable=True)
    expires_at = db.Column(db.BigInteger, nullable=True)
    created_at = db.Column(db.BigInteger, nullable=False)

    __table_args__ = (
        Index('drive_shares_prefix', 'token_prefix'),
        Index('drive_shares_node', 'node_id'),
    )
