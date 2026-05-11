package site.daydream.mote.interceptor

import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import site.daydream.mote.annotation.RateLimit
import site.daydream.mote.exception.TooManyRequestsException
import org.springframework.web.method.HandlerMethod
import org.springframework.web.servlet.HandlerInterceptor
import java.util.concurrent.ConcurrentHashMap

private data class WindowEntry(var count: Int, var resetAt: Long)

class RateLimitInterceptor : HandlerInterceptor {
    private val store = ConcurrentHashMap<String, WindowEntry>()

    override fun preHandle(request: HttpServletRequest, response: HttpServletResponse, handler: Any): Boolean {
        if (handler !is HandlerMethod) return true

        val rateLimit = handler.method.getAnnotation(RateLimit::class.java) ?: return true

        val key = "rate:${request.requestURI}"
        val now = System.currentTimeMillis()
        val windowMs = rateLimit.window * 1000L

        val allowed = synchronized(store) {
            val entry = store[key]
            if (entry == null || now >= entry.resetAt) {
                store[key] = WindowEntry(count = 1, resetAt = now + windowMs)
                true
            } else if (entry.count < rateLimit.max) {
                entry.count++
                true
            } else {
                false
            }
        }

        if (!allowed) {
            throw TooManyRequestsException("Too many attempts, try again later")
        }

        return true
    }
}
