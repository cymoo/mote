import inspect
import pydantic
import threading
import time
from functools import wraps
from typing import Callable, Literal, get_type_hints, Optional
from pydantic import BaseModel
from flask import Flask, Blueprint, request, make_response, Response
from .exception import APIError


class CORS:
    """CORS middleware that can be applied to Flask app or Blueprint"""

    def __init__(
        self,
        allowed_origins: str = '*',
        allowed_methods: str = 'GET, POST, PUT, DELETE, OPTIONS',
        allowed_headers: str = 'Content-Type, Authorization',
        allow_credentials: bool = False,
        max_age: int = 3600,
    ):
        """
        Initialize CORS middleware

        Args:
            allowed_origins: Comma-separated origins or '*' for all origins
            allowed_methods: Allowed HTTP methods
            allowed_headers: Allowed request headers
            allow_credentials: Whether to allow credentials
            max_age: Preflight cache duration in seconds
        """
        self.allowed_methods = allowed_methods
        self.allowed_headers = allowed_headers
        self.allow_credentials = allow_credentials
        self.max_age = max_age

        # Parse origins
        self.origins_list = (
            [o.strip() for o in allowed_origins.split(',')]
            if allowed_origins != '*'
            else ['*']
        )

        # Validate: cannot use credentials with wildcard origin
        if self.allow_credentials and '*' in self.origins_list:
            raise ValueError(
                "CORS: allow_credentials cannot be True when allowed_origins is '*'. "
                "This is a security restriction per CORS specification."
            )

    def is_origin_allowed(self, origin: str) -> bool:
        """Check if the origin is allowed"""
        if '*' in self.origins_list:
            return True
        return origin in self.origins_list

    def set_cors_headers(self, response: Response, origin: str) -> Response:
        """Set CORS headers to the response"""
        # Set Access-Control-Allow-Origin
        if '*' in self.origins_list:
            response.headers['Access-Control-Allow-Origin'] = '*'
        else:
            response.headers['Access-Control-Allow-Origin'] = origin
            # When allowing specific domains, add Vary header to support caching
            vary = response.headers.get('Vary', '')
            if vary:
                if 'Origin' not in vary:
                    response.headers['Vary'] = f"{vary}, Origin"
            else:
                response.headers['Vary'] = 'Origin'

        # Set allowed methods
        response.headers['Access-Control-Allow-Methods'] = self.allowed_methods

        # Set allowed headers
        response.headers['Access-Control-Allow-Headers'] = self.allowed_headers

        # Set Access-Control-Allow-Credentials
        if self.allow_credentials:
            response.headers['Access-Control-Allow-Credentials'] = 'true'

        # Set Access-Control-Max-Age
        response.headers['Access-Control-Max-Age'] = str(self.max_age)

        return response

    def handle_preflight(self) -> Response | None:
        """Handle CORS preflight requests"""
        if request.method == 'OPTIONS':
            origin = request.headers.get('Origin')

            # No origin header, treat as same-origin request
            if not origin:
                return None

            # Check if origin is allowed
            if self.is_origin_allowed(origin):
                response = make_response('', 204)
                self.set_cors_headers(response, origin)
                return response
            else:
                # Origin not allowed, return 403
                return make_response('', 403)

        return None

    def add_cors_headers(self, response: Response) -> Response:
        """Add CORS headers to all responses"""
        origin = request.headers.get('Origin')

        # If no Origin header, no need to handle CORS (same-origin request)
        if not origin:
            return response

        # Check if origin is allowed
        if self.is_origin_allowed(origin):
            self.set_cors_headers(response, origin)

        return response

    def init_app(self, app: Flask | Blueprint) -> None:
        """Register middleware with Flask app or Blueprint"""
        app.before_request(self.handle_preflight)
        app.after_request(self.add_cors_headers)


_rate_limit_lock = threading.Lock()
_rate_limit_store: dict[str, tuple[int, float]] = {}


def rate_limit(max_count: int, expires: int = 60) -> Callable:
    """Decorator to limit the number of requests to a view function.
    Args:
        max_count (int): Maximum number of requests allowed within the expiration period.
        expires (int): Expiration time in seconds for the rate limit window. Default is 60 seconds.
    Returns:
        Callable: A decorator that can be applied to Flask view functions.
    Usage:
        @app.route("/some-endpoint")
        @rate_limit(max_count=5, expires=60)
        def some_view_function():
            ...
    """

    def wrapper(view_func):
        @wraps(view_func)
        def inner(*args, **kw):
            key = 'rate:' + view_func.__qualname__
            now = time.monotonic()
            with _rate_limit_lock:
                count, reset_at = _rate_limit_store.get(key, (0, now + expires))
                if now >= reset_at:
                    count, reset_at = 0, now + expires
                count += 1
                _rate_limit_store[key] = (count, reset_at)
            if count > max_count:
                raise APIError(429, 'Too Many Requests')
            return view_func(*args, **kw)

        return inner

    return wrapper


def validate(
    view_func: Optional[Callable] = None,
    *,
    type: Literal['json', 'query', 'form'] = 'json',  # noqa
):
    """Decorator to validate request data using Pydantic models.
    The first parameter of the decorated view function must be annotated
    with a Pydantic model class. The decorator will parse and validate
    the incoming request data (JSON body, query parameters, or form data)
    against this model before passing it to the view function.
    Args:
        view_func: The view function to be decorated.
        type: The type of request data to validate.
            Can be 'json' for JSON body, 'query' for query parameters, or 'form' for form data.
            Default is 'json'.
    Returns:
        Callable: The decorated view function with request data validation.
    Raises:
        TypeError: If the first parameter is not annotated with a Pydantic model.
        ValidationError: If the request data fails validation.
    Usage:
        @app.post("/some-endpoint")
        @validate
        def some_view_function(payload: SomePydanticModel):
            ...
    """

    from .exception import ValidationError

    def decorator(func):
        hints = get_type_hints(func)

        params = inspect.signature(func).parameters
        first_param_name = next(iter(params), None)

        if first_param_name is None:
            raise TypeError('view function must have at least one parameter')

        model_cls = hints.get(first_param_name)

        if not model_cls or not issubclass(model_cls, BaseModel):
            raise TypeError(
                f"first parameter '{first_param_name}' must be annotated with a Pydantic model"
            )

        if type not in ('json', 'query', 'form'):
            raise ValueError('request type must be json, query, or form')

        @wraps(func)
        def wrapper(*args, **kwargs):
            try:
                if type == 'query':
                    validated_data = model_cls(**request.args)
                elif type == 'form':
                    validated_data = model_cls(**request.form)
                else:
                    validated_data = model_cls(**request.json)

                return func(validated_data, *args, **kwargs)
            except pydantic.ValidationError as err:
                raise ValidationError(_format_validation_error(err))

        return wrapper

    if view_func is None:
        return decorator
    return decorator(view_func)


def _format_validation_error(error: pydantic.ValidationError) -> str:
    """Formats a Pydantic validation error and generates a human-readable
    string that summarizes the validation issues for each field, including nested fields.
    """

    field_errors: dict[str, list[str]] = {}

    for err in error.errors():
        # Handle errors for nested fields
        location = " -> ".join(str(loc) for loc in err["loc"])
        message = err["msg"]

        if location not in field_errors:
            field_errors[location] = []
        field_errors[location].append(message)

    parts = []

    for field, messages in field_errors.items():
        error_text = f"{field}: {' '.join(f'[{msg}]' for msg in messages)}"
        parts.append(error_text)

    return "; ".join(parts)
