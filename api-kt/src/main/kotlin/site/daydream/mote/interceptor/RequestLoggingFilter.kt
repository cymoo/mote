package site.daydream.mote.interceptor

import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.slf4j.LoggerFactory
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.stereotype.Component
import org.springframework.util.AntPathMatcher
import org.springframework.web.filter.OncePerRequestFilter
import kotlin.math.log10
import kotlin.math.pow

@ConfigurationProperties(prefix = "logging.request")
data class RequestLoggingProperties(
    val enabled: Boolean = false,
    val excludePaths: List<String> = listOf(
        "/actuator/**",
        "/static/**",
        "/health",
        "/favicon.ico"
    )
)

@Component
@ConditionalOnProperty(
    prefix = "logging.request",
    name = ["enabled"],
    havingValue = "true",
    matchIfMissing = true
)
class RequestLoggingFilter(
    private val properties: RequestLoggingProperties
) : OncePerRequestFilter() {

    private val httpLogger = LoggerFactory.getLogger(javaClass)
    private val pathMatcher = AntPathMatcher()

    override fun shouldNotFilter(request: HttpServletRequest): Boolean {
        val path = request.servletPath
        return properties.excludePaths.any { pattern ->
            pathMatcher.match(pattern, path)
        }
    }

    override fun doFilterInternal(
        request: HttpServletRequest,
        response: HttpServletResponse,
        filterChain: FilterChain
    ) {
        val startTime = System.nanoTime()
        try {
            filterChain.doFilter(request, response)
        } finally {
            // Skip access-log line on async-dispatch hand-off; a final pass will run
            // when async completes (or for sync responses, this branch is the only pass).
            if (!request.isAsyncStarted) {
                logRequest(request, response, startTime)
            }
        }
    }

    private fun logRequest(
        request: HttpServletRequest,
        response: HttpServletResponse,
        startTime: Long
    ) {
        val duration = System.nanoTime() - startTime
        val method = request.method
        val protocol = request.protocol
        val url = buildUrl(request)
        val remoteAddr = getRemoteAddress(request)
        val remotePort = request.remotePort
        val status = response.status
        // For streaming/async responses we don't know the final body size at this point.
        // Use the Content-Length header if present, else 0.
        val contentLength = response.getHeader("Content-Length")?.toLongOrNull() ?: 0L

        val formattedSize = formatBytes(contentLength)
        val formattedDuration = formatDuration(duration)

        httpLogger.info("\"$method $url $protocol\" from $remoteAddr:$remotePort - $status $formattedSize in $formattedDuration")
    }

    private fun buildUrl(request: HttpServletRequest): String {
        val url = StringBuilder()
            .append(request.scheme)
            .append("://")
            .append(request.serverName)

        val port = request.serverPort
        if ((request.scheme == "http" && port != 80) ||
            (request.scheme == "https" && port != 443)
        ) {
            url.append(":").append(port)
        }

        url.append(request.contextPath).append(request.servletPath)

        request.queryString?.let { url.append("?").append(it) }

        return url.toString()
    }

    private fun getRemoteAddress(request: HttpServletRequest): String {
        return request.getHeader("X-Forwarded-For")
            ?.split(",")?.first()?.trim()
            ?: request.getHeader("X-Real-IP")
            ?: request.remoteAddr
    }

    private fun formatBytes(bytes: Long): String {
        if (bytes == 0L) return "0B"

        val units = arrayOf("B", "KB", "MB", "GB", "TB")
        val digitGroups = (log10(bytes.toDouble()) / log10(1024.0)).toInt()
            .coerceIn(0, units.size - 1)

        return if (digitGroups == 0) {
            "${bytes}B"
        } else {
            val value = bytes / 1024.0.pow(digitGroups.toDouble())
            "%.1f%s".format(value, units[digitGroups])
        }
    }

    private fun formatDuration(nanos: Long): String {
        return when {
            nanos < 1_000 -> "${nanos}ns"
            nanos < 1_000_000 -> "%.3fμs".format(nanos / 1_000.0)
            nanos < 1_000_000_000 -> "%.3fms".format(nanos / 1_000_000.0)
            else -> "%.3fs".format(nanos / 1_000_000_000.0)
        }
    }
}
