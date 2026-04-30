from typing import Optional, Dict, Any, NoReturn

from flask import jsonify, Flask, abort
from werkzeug.exceptions import HTTPException


class APIError(Exception):
    def __init__(self, code: int, error: str, message: Optional[str] = None):
        self.code = code
        self.error = error
        self.message = message

    def to_dict(self) -> Dict[str, Any]:
        rv = {'code': self.code, 'error': self.error}
        if self.message:
            rv['message'] = self.message
        return rv


class ValidationError(APIError):
    def __init__(self, message: Optional[str] = None):
        super().__init__(400, 'Bad Request', message)


def register_error_handlers(app: Flask) -> None:
    from .logger import logger

    @app.errorhandler(APIError)
    def handle_api_error(error: APIError):
        response = jsonify(error.to_dict())
        response.status_code = error.code
        return response

    @app.errorhandler(HTTPException)
    def handle_http_exception(error: HTTPException):
        response = jsonify(
            {'code': error.code, 'error': error.name, 'message': error.description}
        )
        response.status_code = error.code
        return response

    @app.errorhandler(Exception)
    def handle_generic_error(error):
        logger.error(f'Unhandled exception: {str(error)}', exc_info=True)
        response = jsonify({'code': 500, 'error': 'Internal Server Error'})
        response.status_code = 500
        return response


def not_found(message: Optional[str] = None) -> NoReturn:
    abort(404, description=message)


def bad_request(message: Optional[str] = None) -> NoReturn:
    abort(400, description=message)
