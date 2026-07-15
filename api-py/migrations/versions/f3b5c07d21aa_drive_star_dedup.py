"""drive star + dedup indexes

Mirrors api-go/assets/migrations/003_drive_star_dedup.up.sql.

Revision ID: f3b5c07d21aa
Revises: 98a1ebb8af73
Create Date: 2026-07-15 10:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'f3b5c07d21aa'
down_revision = '98a1ebb8af73'
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c['name'] for c in inspector.get_columns('drive_nodes')}
    if 'starred_at' not in columns:
        # Starred flag: NULL = not starred; epoch-ms when starred (doubles as
        # sort key). Skipped when another backend already applied it.
        op.add_column(
            'drive_nodes', sa.Column('starred_at', sa.BigInteger(), nullable=True)
        )

    # Dedup lookups (find_reusable_blob) filter by content hash.
    op.execute(
        'CREATE INDEX IF NOT EXISTS drive_nodes_hash '
        'ON drive_nodes (hash) WHERE hash IS NOT NULL'
    )
    # Blob refcount checks (remove_blob_if_orphan) and physical-usage stats
    # filter/group by blob_path.
    op.execute(
        'CREATE INDEX IF NOT EXISTS drive_nodes_blob_path '
        'ON drive_nodes (blob_path) WHERE blob_path IS NOT NULL'
    )
    op.execute(
        'CREATE INDEX IF NOT EXISTS drive_nodes_starred '
        'ON drive_nodes (starred_at) WHERE starred_at IS NOT NULL'
    )


def downgrade():
    op.execute('DROP INDEX IF EXISTS drive_nodes_starred')
    op.execute('DROP INDEX IF EXISTS drive_nodes_blob_path')
    op.execute('DROP INDEX IF EXISTS drive_nodes_hash')
    op.drop_column('drive_nodes', 'starred_at')
