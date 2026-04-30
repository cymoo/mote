import os
from flask import Flask
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import MetaData
from redis import Redis
from .lib.search import FullTextSearch


# https://stackoverflow.com/questions/45527323
naming_convention = {
    "ix": 'ix_%(column_0_label)s',
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(column_0_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}

db: SQLAlchemy = SQLAlchemy(metadata=MetaData(naming_convention=naming_convention))
rd: Redis = None  # type: ignore
fts: FullTextSearch = None  # type: ignore


def init_app(app: Flask) -> None:
    global db, rd, fts

    db.init_app(app)
    # Inject app into db for convenience, it's not a common practice though
    db.app = app

    rd = Redis.from_url(app.config['REDIS_URL'], decode_responses=True)
    fts = FullTextSearch(rd, 'fts:')


def run_migration(app: Flask, sa: SQLAlchemy) -> None:
    """Bring the database schema up to date.

    On a fresh database we run ``upgrade`` to apply every revision and have
    Alembic record the head; on an already-current database we exit early
    without doing any work (and without re-importing flask_migrate).

    The actual upgrade is delegated to ``alembic.command.upgrade`` directly
    so we don't depend on ``flask_migrate``'s CLI plumbing — that path
    swallowed our log handlers and required a subprocess workaround.
    """
    from flask_migrate import Migrate

    from .logger import logger

    # Register flask_migrate so the `flask db ...` CLI continues to work
    # for developers; we don't use any of its runtime helpers here.
    Migrate(app, sa)

    if not os.path.exists('migrations'):
        logger.warning(
            "Migrations folder not found; creating tables directly. "
            "Run `flask db init && flask db migrate && flask db upgrade` "
            "to enable proper schema versioning."
        )
        with app.app_context():
            sa.create_all()
        return

    with app.app_context():
        current = _current_revision(sa)
        head = _head_revision()
        if current == head:
            return

        try:
            _alembic_upgrade()
            logger.info('Database migrated to %s', head)
        except Exception as e:
            logger.error('Database migration failed: %s', e)
            raise


def _alembic_config():
    from alembic.config import Config as AlembicConfig

    cfg = AlembicConfig(os.path.join('migrations', 'alembic.ini'))
    cfg.set_main_option('script_location', 'migrations')
    return cfg


def _alembic_upgrade(target: str = 'head') -> None:
    from alembic import command

    command.upgrade(_alembic_config(), target)


def _head_revision() -> str | None:
    from alembic.script import ScriptDirectory

    return ScriptDirectory.from_config(_alembic_config()).get_current_head()


def _current_revision(sa: SQLAlchemy) -> str | None:
    from sqlalchemy import inspect, text

    if 'alembic_version' not in inspect(sa.engine).get_table_names():
        return None
    row = sa.session.execute(
        text('SELECT version_num FROM alembic_version LIMIT 1')
    ).first()
    return row[0] if row else None
