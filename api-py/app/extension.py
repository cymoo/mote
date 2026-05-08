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
