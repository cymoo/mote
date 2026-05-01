package site.daydream.mote.controller

import jakarta.servlet.http.Cookie
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.*
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody
import site.daydream.mote.exception.AuthenticationException
import site.daydream.mote.exception.NotFoundException
import site.daydream.mote.model.DriveShare
import site.daydream.mote.service.DriveService
import site.daydream.mote.service.DriveShareService
import site.daydream.mote.service.RedisService
import java.io.File
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

private const val COOKIE_PREFIX = "drive_share_pw_"

@RestController
@RequestMapping("/shared-files")
class DriveSharePageController(
    private val driveService: DriveService,
    private val shareService: DriveShareService,
    private val redis: RedisService,
) {

    @GetMapping("/{token}")
    fun landing(
        @PathVariable token: String,
        request: HttpServletRequest,
    ): ResponseEntity<Any> {
        val (share, node) = shareService.resolve(token)
        val authed = passwordOk(request, share, token)
        val accept = request.getHeader("Accept") ?: ""

        if (accept.contains("application/json")) {
            val body = mapOf(
                "name" to node.name,
                "size" to (node.size ?: 0),
                "mime_type" to node.mimeType,
                "has_password" to !share.passwordHash.isNullOrEmpty(),
                "authed" to authed,
                "expires_at" to share.expiresAt,
            )
            return ResponseEntity.ok().contentType(MediaType.APPLICATION_JSON).body(body)
        }
        val html = renderLanding(
            name = node.name,
            size = humanSize(node.size ?: 0),
            mimeType = node.mimeType ?: "application/octet-stream",
            hasPassword = !share.passwordHash.isNullOrEmpty(),
            authed = authed,
            token = token,
        )
        return ResponseEntity.ok().contentType(MediaType.TEXT_HTML).body(html)
    }

    @PostMapping("/{token}/auth", consumes = [MediaType.APPLICATION_FORM_URLENCODED_VALUE])
    fun auth(
        @PathVariable token: String,
        @RequestParam(required = false) password: String?,
        request: HttpServletRequest,
        response: HttpServletResponse,
    ): ResponseEntity<Void> {
        if (!rateLimit(token, clientIp(request))) {
            return ResponseEntity.status(429).build()
        }
        val (share, _) = shareService.resolve(token)
        shareService.verifyPassword(share, password ?: "")
        val cookieValue = cookieValue(share, token)

        val cookie = Cookie(cookieName(token), cookieValue).apply {
            path = "/shared-files/$token"
            isHttpOnly = true
            maxAge = 60 * 60 * 24
        }
        response.addCookie(cookie)
        return ResponseEntity.status(303).header(HttpHeaders.LOCATION, "/shared-files/$token").build()
    }

    @GetMapping("/{token}/download")
    fun download(@PathVariable token: String, request: HttpServletRequest): ResponseEntity<*> =
        serveShared(token, request, true)

    @GetMapping("/{token}/preview")
    fun preview(@PathVariable token: String, request: HttpServletRequest): ResponseEntity<*> =
        serveShared(token, request, false)

    private fun serveShared(token: String, request: HttpServletRequest, forceAttachment: Boolean): ResponseEntity<*> {
        val (share, node) = shareService.resolve(token)
        if (!share.passwordHash.isNullOrEmpty() && !passwordOk(request, share, token)) {
            return ResponseEntity.status(303).header(HttpHeaders.LOCATION, "/shared-files/$token").build<Void>()
        }
        if (node.blobPath.isNullOrBlank()) throw NotFoundException("not found")
        val abs = File(driveService.blobAbsPath(node.blobPath))
        if (!abs.exists()) throw NotFoundException("not found")

        val mt = node.mimeType ?: "application/octet-stream"
        val disp = if (forceAttachment || DriveController.mustForceAttachment(mt, node.ext ?: "")) "attachment" else "inline"

        val body = StreamingResponseBody { out -> abs.inputStream().use { it.copyTo(out) } }
        return ResponseEntity.ok()
            .header(HttpHeaders.CONTENT_TYPE, mt)
            .header(HttpHeaders.CONTENT_LENGTH, abs.length().toString())
            .header(
                HttpHeaders.CONTENT_DISPOSITION,
                "$disp; filename*=UTF-8''${urlEncode(node.name)}",
            )
            .header("X-Content-Type-Options", "nosniff")
            .body(body)
    }

    private fun passwordOk(req: HttpServletRequest, share: DriveShare, token: String): Boolean {
        if (share.passwordHash.isNullOrEmpty()) return true
        val c = req.cookies?.firstOrNull { it.name == cookieName(token) } ?: return false
        return constantTimeEquals(c.value, cookieValue(share, token))
    }

    private fun cookieValue(share: DriveShare, token: String): String {
        val key = share.passwordHash ?: throw AuthenticationException("share has no password")
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key.toByteArray(StandardCharsets.UTF_8), "HmacSHA256"))
        return mac.doFinal(token.toByteArray(StandardCharsets.UTF_8)).toHex()
    }

    private fun cookieName(token: String): String {
        val take = token.take(8).replace('-', '_')
        return COOKIE_PREFIX + take
    }

    /** Returns true if request should be allowed (rate limit OK). 10 attempts / 5 min per (token, ip). */
    private fun rateLimit(token: String, ip: String): Boolean {
        val key = "drive:share:rl:$token:$ip"
        return try {
            val n = redis.incr(key)
            if (n == 1L) {
                redis.executeSync { it.expire(key, 5L * 60) }
            }
            n <= 10
        } catch (_: Exception) {
            true
        }
    }

    private fun clientIp(req: HttpServletRequest): String {
        req.getHeader("X-Forwarded-For")?.let { v ->
            val first = v.substringBefore(',').trim()
            if (first.isNotEmpty()) return first
        }
        req.getHeader("X-Real-IP")?.takeIf { it.isNotBlank() }?.let { return it }
        return req.remoteAddr ?: ""
    }

    companion object {
        fun urlEncode(s: String): String =
            URLEncoder.encode(s, StandardCharsets.UTF_8).replace("+", "%20")

        fun humanSize(n: Long): String {
            if (n < 1024) return "$n B"
            val units = arrayOf("KB", "MB", "GB", "TB")
            var v = n.toDouble() / 1024
            var i = 0
            while (v >= 1024 && i < units.size - 1) { v /= 1024; i++ }
            return "%.1f %s".format(v, units[i])
        }

        private fun esc(s: String): String =
            s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                .replace("\"", "&quot;").replace("'", "&#39;")

        private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it.toInt() and 0xff) }

        private fun constantTimeEquals(a: String, b: String): Boolean {
            if (a.length != b.length) return false
            var diff = 0
            for (i in a.indices) diff = diff or (a[i].code xor b[i].code)
            return diff == 0
        }

        fun renderLanding(
            name: String,
            size: String,
            mimeType: String,
            hasPassword: Boolean,
            authed: Boolean,
            token: String,
        ): String {
            val n = esc(name); val s = esc(size); val t = esc(token)
            val cta = if (hasPassword && !authed) {
                """<form method="post" action="/shared-files/$t/auth">
                    <input type="password" name="password" placeholder="Password" autofocus required />
                    <button type="submit">Unlock</button>
                  </form>"""
            } else {
                val preview = when {
                    mimeType.startsWith("video/") ->
                        """<video class="preview" src="/shared-files/$t/preview" controls preload="metadata"></video>"""
                    mimeType.startsWith("audio/") ->
                        """<audio class="preview" src="/shared-files/$t/preview" controls preload="metadata"></audio>"""
                    else -> ""
                }
                """$preview<div class="actions"><a class="btn" href="/shared-files/$t/download">Download</a></div>"""
            }
            return """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>$n · Mote Drive</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         display:flex; align-items:center; justify-content:center; min-height:100vh;
         background:#fafafa; margin:0; color:#1a1a1a; }
  .card { background:#fff; padding:32px 36px; border-radius:14px; box-shadow:0 4px 24px rgba(0,0,0,.06);
          max-width:420px; width:100%; }
  h1 { font-size:18px; margin:0 0 4px; word-break:break-all; }
  p.size { color:#888; margin:0 0 24px; font-size:13px; }
  a.btn, button { display:inline-block; padding:10px 18px; border-radius:8px; background:#111;
           color:#fff; text-decoration:none; border:0; cursor:pointer; font-size:14px; }
  .actions { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
  .preview { display:block; width:100%; max-height:60vh; margin:0 0 16px; border-radius:10px; background:#000; }
  audio.preview { background:transparent; }
  input[type=password] { width:100%; padding:10px 12px; border:1px solid #ddd; border-radius:8px;
           font-size:14px; box-sizing:border-box; margin-bottom:12px; }
  form { margin-top:8px; } .meta { color:#666; font-size:13px; margin-top:18px; }
</style></head><body>
<div class="card"><h1>$n</h1><p class="size">$s</p>$cta
<p class="meta">Shared via Mote Drive</p></div></body></html>"""
        }
    }
}
