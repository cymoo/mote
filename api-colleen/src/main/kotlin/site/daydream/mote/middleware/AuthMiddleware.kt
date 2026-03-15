package site.daydream.mote.middleware

import io.github.cymoo.colleen.Context
import io.github.cymoo.colleen.Next
import site.daydream.mote.exception.AuthenticationException
import site.daydream.mote.service.AuthService

/**
 * Authentication middleware that checks for a valid token in cookies or Authorization header.
 * Paths listed in excludePaths are not checked.
 */
class AuthMiddleware(
    private val authService: AuthService,
    private val excludePaths: Set<String> = emptySet()
) {
    fun invoke(ctx: Context, next: Next) {
        val path = ctx.request.path

        // Skip auth for excluded paths
        if (excludePaths.any { path == it || path.startsWith("$it/") }) {
            next()
            return
        }

        val token = ctx.request.cookie("token") ?: extractBearer(ctx)

        if (token.isNullOrEmpty()) {
            throw AuthenticationException("No token provided")
        }

        if (!authService.isValidToken(token)) {
            throw AuthenticationException("Invalid token")
        }

        next()
    }

    private fun extractBearer(ctx: Context): String? {
        val authHeader = ctx.header("Authorization") ?: return null
        if (authHeader.startsWith("Bearer ")) {
            return authHeader.removePrefix("Bearer ").trim()
        }
        return null
    }
}
