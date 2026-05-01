"""add drive share token

Revision ID: ac0d1b2c3e4f
Revises: 98a1ebb8af73
Create Date: 2026-05-01 10:06:55.385000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'ac0d1b2c3e4f'
down_revision = '98a1ebb8af73'
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing_cols = {c['name'] for c in inspector.get_columns('drive_shares')}
    if 'token' in existing_cols:
        return
    op.add_column('drive_shares', sa.Column('token', sa.Text(), nullable=True))


def downgrade():
    op.drop_column('drive_shares', 'token')
