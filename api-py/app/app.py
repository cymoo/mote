"""
Application factory
~~~~~~~~~~~~~~~~~~~
"""

import os
import logging
from dataclasses import is_dataclass

from flask import Flask, send_from_directory, jsonify
from flask.json.provider import JSONProvider
from orjson import orjson


def create_app(config) -> Flask:
    """Create Flask application instance"""

    from .exception import register_error_handlers
    from .task import huey

    app = Flask(
        'app',
        static_folder='../static',
        template_folder='../templates',
    )

    make_response_of_dataclass(app)

    app.json = ORJSONProvider(app)

    app.config.from_object(config)
    app.cfg = config

    setup_logger(app)
    init_extension(app)
    register_drive_services(app)
    register_blueprints(app)
    register_cors_handlers(app)
    register_file_uploads(app)
    register_error_handlers(app)

    # Run periodic tasks
    huey.start()

    return app


def setup_logger(app: Flask) -> None:
    from .logger import config_logger

    config = app.config
    LOG_CONSOLE = config['LOG_CONSOLE']
    LOG_FILE = config['LOG_FILE']
    LOG_LEVEL = config['LOG_LEVEL']
    LOG_REQUESTS = config['LOG_REQUESTS']
    LOG_MAX_BYTES = config['LOG_MAX_BYTES']
    LOG_MAX_BACKUPS = config['LOG_MAX_BACKUPS']

    level = getattr(logging, LOG_LEVEL.upper(), logging.INFO)

    config_logger(
        level=level,
        console_output=LOG_CONSOLE,
        log_file=LOG_FILE,
        include_request_context=LOG_REQUESTS,
        max_bytes=LOG_MAX_BYTES,
        max_backups=LOG_MAX_BACKUPS,
    )


def init_extension(app: Flask) -> None:
    from .extension import init_app, db, run_migration
    from sqlalchemy import text

    init_app(app)

    # enable foreign key constraint and WAL mode for SQLite
    with app.app_context():
        db.session.execute(text("PRAGMA foreign_keys=ON"))
        db.session.execute(text("PRAGMA journal_mode=WAL"))

    # Run migrations if enabled
    if app.config['DATABASE_AUTO_MIGRATE']:
        run_migration(app, db)


def register_blueprints(app: Flask) -> None:
    from .handler.api import api
    from .handler.blog import blog
    from .handler.drive import drive_bp
    from .handler.shared_drive import shared_bp

    app.register_blueprint(api, url_prefix='/api')
    app.register_blueprint(blog, url_prefix='/shared')
    app.register_blueprint(drive_bp, url_prefix='/api/drive')
    app.register_blueprint(shared_bp, url_prefix='/shared-files')


def register_drive_services(app: Flask) -> None:
    from .services.drive import DriveService
    from .services.drive_share import DriveShareService
    from .services.drive_upload import DriveUploadService

    upload_path = app.config['UPLOAD_PATH']
    drive = DriveService(upload_path)
    app.drive_service = drive
    app.drive_upload_service = DriveUploadService(drive)
    app.drive_share_service = DriveShareService(drive)


def register_file_uploads(app: Flask) -> None:
    upload_path = app.config['UPLOAD_PATH']
    upload_url = app.config['UPLOAD_URL']
    if not os.path.exists(upload_path):
        os.mkdir(upload_path)

    @app.route(f'{upload_url}/<path:filename>')
    def uploaded_file(filename):
        abs_path = os.path.abspath(upload_path)
        return send_from_directory(abs_path, filename)


def register_cors_handlers(app: Flask) -> None:
    from .middleware import CORS

    # Get CORS settings from config
    config = app.config
    allowed_origins = config['CORS_ALLOWED_ORIGINS']
    allowed_methods = config['CORS_ALLOWED_METHODS']
    allowed_headers = config['CORS_ALLOWED_HEADERS']
    allow_credentials = config['CORS_ALLOW_CREDENTIALS']
    max_age = config['CORS_MAX_AGE']

    cors = CORS(
        allowed_origins=allowed_origins,
        allowed_methods=allowed_methods,
        allowed_headers=allowed_headers,
        allow_credentials=allow_credentials,
        max_age=max_age,
    )
    # It's better to register CORS only for API blueprint, but for simplicity we register it for the whole app
    cors.init_app(app)


def make_response_of_dataclass(app):
    """Override Flask's make_response to support dataclass directly"""
    original_make_response = app.make_response

    def new_make_response(rv):
        if is_dataclass(rv):
            rv = jsonify(rv)
        return original_make_response(rv)

    app.make_response = new_make_response


class ORJSONProvider(JSONProvider):
    """Custom JSON provider using orjson for Flask applications."""

    def __init__(self, *args, **kwargs):
        self.options = kwargs
        super().__init__(*args, **kwargs)

    def loads(self, s, **kwargs):
        return orjson.loads(s)

    def dumps(self, obj, **kwargs):
        # Decode back to str, as orjson returns bytes
        return orjson.dumps(obj, option=orjson.OPT_NON_STR_KEYS).decode('utf-8')
