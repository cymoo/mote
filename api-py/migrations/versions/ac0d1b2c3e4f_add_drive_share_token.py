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
    op.add_column('drive_shares', sa.Column('token', sa.Text(), nullable=True))


def downgrade():
    op.drop_column('drive_shares', 'token')
