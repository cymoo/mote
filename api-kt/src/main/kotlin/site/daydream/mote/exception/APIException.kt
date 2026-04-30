package site.daydream.mote.exception

import com.fasterxml.jackson.annotation.JsonInclude

open class APIException(
    val code: Int,
    val error: String,
    override val message: String? = null,
) : RuntimeException(message)

class NotFoundException(message: String?) :
    APIException(404, "Not Found", message)

class BadRequestException(message: String?) :
    APIException(400, "Bad Request", message)

class AuthenticationException(message: String?) :
    APIException(401, "Unauthorized", message)

class ConflictException(message: String?) :
    APIException(409, "Conflict", message)

class GoneException(message: String?) :
    APIException(410, "Gone", message)


data class ErrorResponse(
    val code: Int,
    val error: String,
    @JsonInclude(JsonInclude.Include.NON_NULL)
    val message: String? = null,
    // val path: String,
    // @JsonFormat(pattern = "yyyy-MM-dd HH:mm:ss")
    // val timestamp: LocalDateTime = LocalDateTime.now()
)

