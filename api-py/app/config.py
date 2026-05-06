import os
from pathlib import Path
from dotenv import load_dotenv
from pathlib import PurePath
from dataclasses import dataclass, fields
from typing import get_origin, get_args, Union
import types

PY_ROOT = str(PurePath(__file__).parent.parent)


@dataclass
class Config:
    """Application configuration"""

    # Flask
    FLASK_ENV: str = os.getenv("FLASK_ENV", "production").lower()
    SECRET_KEY: str = 'fool-said-i-you-do-not-know'
    MAX_CONTENT_LENGTH: int = 10 * 1024 * 1024  # 10 MB

    # Basic app info
    APP_NAME: str = 'mote'
    APP_VERSION: str = '1.0.0'

    # Application settings
    POSTS_PER_PAGE: int = 20
    ABOUT_URL: str | None = None

    # Database
    SQLALCHEMY_DATABASE_URI: str = 'sqlite:///app.db'
    # SQLALCHEMY_DATABASE_URI: str = 'sqlite:///:memory:'
    SQLALCHEMY_TRACK_MODIFICATIONS: bool = False
    SQLALCHEMY_ECHO: bool = False
    DATABASE_AUTO_MIGRATE: bool = True

    # Redis
    REDIS_URL: str = 'redis://localhost:6379/0'

    # Upload
    UPLOAD_PATH: str = os.path.join(PY_ROOT, 'uploads')
    UPLOAD_URL: str = '/uploads'
    DRIVE_ACCEL_REDIRECT_PREFIX: str = ''
    UPLOAD_IMAGE_FORMATS: set = frozenset({'png', 'jpg', 'jpeg', 'gif', 'webp'})
    UPLOAD_THUMB_WIDTH: int = 128

    # CORS
    CORS_ALLOWED_ORIGINS: str = '*'
    CORS_ALLOWED_METHODS: str = 'GET, POST, PUT, DELETE, OPTIONS'
    CORS_ALLOWED_HEADERS: str = 'Content-Type, Authorization'
    CORS_ALLOW_CREDENTIALS: bool = False
    CORS_MAX_AGE: int = 86400

    # Logging
    LOG_CONSOLE: bool = True
    LOG_FILE: str = ''
    LOG_LEVEL: str = 'INFO'
    LOG_REQUESTS: bool = True
    LOG_MAX_BYTES: int = 10 * 1024 * 1024  # 10 MB
    LOG_MAX_BACKUPS: int = 10

    @classmethod
    def from_env(cls) -> 'Config':
        """Create Config instance from environment variables."""

        config = cls()
        load_env_files(config.FLASK_ENV)

        env_mapping = {
            'DATABASE_URL': 'SQLALCHEMY_DATABASE_URI',
            'HTTP_MAX_BODY_SIZE': 'MAX_CONTENT_LENGTH',
        }

        for field in fields(cls):
            # First check field name
            env_name = field.name
            env_value = os.getenv(env_name)

            # Then check alias
            if env_value is None:
                for alias, target in env_mapping.items():
                    if target == field.name:
                        env_value = os.getenv(alias)
                        if env_value is not None:
                            break

            # If found in environment, set the value
            if env_value is not None:
                # Extract the actual type from Optional/Union types
                field_type = field.type
                origin = get_origin(field_type)

                # Handle Union types (including Optional which is Union[T, None])
                # Python 3.10+ uses types.UnionType for | syntax
                if origin is Union or isinstance(field_type, types.UnionType):
                    # Get non-None types from the Union
                    args = get_args(field_type)
                    non_none_types = [arg for arg in args if arg is not type(None)]
                    if non_none_types:
                        field_type = non_none_types[0]

                # Now parse based on the actual type
                if field_type == bool or field_type is bool:
                    value = env_value.lower() in ('true', '1', 'yes', 'on', 'y')
                elif field_type == int or field_type is int:
                    value = int(parse_size(env_value))
                elif field_type == float or field_type is float:
                    value = parse_size(env_value)
                elif field_type == frozenset or field_type is frozenset:
                    value = frozenset(env_value.split(','))
                else:
                    value = env_value

                setattr(config, field.name, value)

        config.validate()
        return config

    def validate(self) -> None:
        """Validate configuration values and raise errors if an validation fails."""

        errors = []

        if self.POSTS_PER_PAGE <= 0:
            errors.append("POSTS_PER_PAGE must be greater than 0")
        if self.POSTS_PER_PAGE > 1000:
            errors.append("POSTS_PER_PAGE cannot exceed 1000")

        # Validate Upload config
        if not self.UPLOAD_URL:
            errors.append("UPLOAD_URL cannot be empty")
        if self.DRIVE_ACCEL_REDIRECT_PREFIX and not self.DRIVE_ACCEL_REDIRECT_PREFIX.startswith('/'):
            errors.append("DRIVE_ACCEL_REDIRECT_PREFIX must start with '/'")

        if not self.UPLOAD_PATH:
            errors.append("UPLOAD_PATH cannot be empty")
        else:
            # Resolve to absolute path so downstream send_file / os.stat calls
            # don't depend on the working directory at request time.
            self.UPLOAD_PATH = os.path.abspath(self.UPLOAD_PATH)
            path = Path(self.UPLOAD_PATH)
            try:
                # Try to create directory if it doesn't exist
                path.mkdir(parents=True, exist_ok=True)

                # Check if directory is writable
                test_file = path / ".write_test"
                try:
                    test_file.write_text("test")
                    test_file.unlink()
                except Exception as e:
                    errors.append(
                        f"Upload directory '{self.UPLOAD_PATH}' is not writable: {e}"
                    )
            except Exception as e:
                errors.append(
                    f"Failed to create upload directory '{self.UPLOAD_PATH}': {e}"
                )

        if self.UPLOAD_THUMB_WIDTH <= 0:
            errors.append("UPLOAD_THUMB_WIDTH must be greater than 0")
        if self.UPLOAD_THUMB_WIDTH > 4096:
            errors.append("UPLOAD_THUMB_WIDTH cannot exceed 4096")

        # If there are validation errors, raise exception with all of them
        if errors:
            message = "Configuration validation failed:\n  - " + "\n  - ".join(errors)
            raise ValueError(message)


def load_env_files(env: str) -> None:
    """
    Load environment files based on env type with the following priority:
    1. .env (base configuration)
    2. .env.[environment] (environment-specific configuration)
    3. .env.local (local overrides)

    Args:
        env: Explicitly specify the environment (e.g., 'dev', 'prod', 'test').
    """

    # 1. Load base .env file if exists
    if os.path.exists(".env"):
        load_dotenv(".env")

    # 2. Load environment-specific file
    env_mappings = {
        "dev": ".env.dev",
        "development": ".env.dev",
        "prod": ".env.prod",
        "production": ".env.prod",
        "test": ".env.test",
    }

    env_file = env_mappings.get(env)
    if env_file and os.path.exists(env_file):
        load_dotenv(env_file, override=True)

    # 3. Always load .env.local last for final overrides
    if os.path.exists(".env.local"):
        load_dotenv(".env.local", override=True)


def parse_size(s: str) -> float:
    """Parse a human-readable size string into a float number.
    >>> parse_size("10M")
    10485760.0
    >>> parse_size("512k")
    524288.0
    >>> parse_size("1G")
    1073741824.0
    >>> parse_size("2.5T")
    2748779069440.0
    >>> parse_size("100")
    100.0
    >>> parse_size("-100")
    -100.0
    >>> parse_size("-10k")
    -10240.0
    """
    s = s.strip()
    if not s:
        raise ValueError("empty string")

    # Check for unit suffix
    if s[-1].isalpha():
        num_str = s[:-1]
        unit = s[-1].lower()
    else:
        num_str = s
        unit = ''

    # Parse the numeric part
    try:
        num = float(num_str)
    except ValueError:
        raise ValueError(f"invalid number format: {num_str}")

    # Unit multipliers
    units = {
        'k': 1024,
        'm': 1024**2,
        'g': 1024**3,
        't': 1024**4,
        '': 1,
    }

    if unit not in units:
        raise ValueError(f"invalid unit: {unit} (use k, m, g, t)")

    return num * units[unit]
