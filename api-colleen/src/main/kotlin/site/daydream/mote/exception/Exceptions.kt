package site.daydream.mote.exception

import io.github.cymoo.colleen.HttpException

class NotFoundException(message: String = "Not Found") :
    HttpException(404, message, "NOT_FOUND")

class BadRequestException(message: String = "Bad Request") :
    HttpException(400, message, "BAD_REQUEST")

class AuthenticationException(message: String = "Unauthorized") :
    HttpException(401, message, "UNAUTHORIZED")
