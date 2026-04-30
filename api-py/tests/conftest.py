import os
import shutil
import tempfile

import pytest
from app.config import Config
from app import create_app
from app.model import db as _db


@pytest.fixture(scope="session")
def app():
    config = Config.from_env()
    database_url = os.environ.get("DATABASE_URL_TEST") or "sqlite:///:memory:"
    config.SQLALCHEMY_DATABASE_URI = database_url

    # Per-test-suite tmp upload root for drive blobs/chunks/thumbs.
    upload_dir = tempfile.mkdtemp(prefix='mote-drive-test-')
    config.UPLOAD_PATH = upload_dir
    # Tests use db.create_all() directly; skip Alembic to keep startup fast.
    config.DATABASE_AUTO_MIGRATE = False

    app = create_app(config)
    with app.app_context():
        _db.create_all()
    try:
        yield app
    finally:
        shutil.rmtree(upload_dir, ignore_errors=True)


@pytest.fixture(scope='session')
def db(app):
    with app.app_context():
        yield _db
        _db.drop_all()


@pytest.fixture(scope='function')
def session(db):
    db.session.begin_nested()

    yield db.session

    db.session.rollback()
    db.session.remove()


@pytest.fixture()
def client(app, clean_drive):
    return app.test_client()


@pytest.fixture()
def clean_drive(app):
    """Wipe all drive_* state before each drive test so service-level
    `db.session.commit()`s in earlier tests don't leak.
    """
    from sqlalchemy import text

    with app.app_context():
        _db.session.execute(text('DELETE FROM drive_shares'))
        _db.session.execute(text('DELETE FROM drive_uploads'))
        _db.session.execute(text('DELETE FROM drive_nodes'))
        _db.session.commit()

    upload_path = app.config['UPLOAD_PATH']
    for sub in ('drive', os.path.join('drive', '_chunks'), os.path.join('drive', '_thumbs')):
        p = os.path.join(upload_path, sub)
        shutil.rmtree(p, ignore_errors=True)
        os.makedirs(p, exist_ok=True)
    yield

