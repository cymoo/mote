package site.daydream.mote.controller

import jakarta.servlet.http.Cookie
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.*
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody
import site.daydream.mote.config.UploadConfig
import site.daydream.mote.exception.AuthenticationException
import site.daydream.mote.exception.BadRequestException
import site.daydream.mote.exception.NotFoundException
import site.daydream.mote.model.DriveBreadcrumb
import site.daydream.mote.model.DriveNode
import site.daydream.mote.model.DriveShare
import site.daydream.mote.service.DriveService
import site.daydream.mote.service.DriveShareService
import site.daydream.mote.service.DriveThumbService
import site.daydream.mote.service.DriveZipService
import site.daydream.mote.service.RedisService
import java.io.File
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

private const val COOKIE_PREFIX = "drive_share_pw_"

@RestController
@RequestMapping("/shared-files")
class DriveShareController(
    private val driveService: DriveService,
    private val shareService: DriveShareService,
    private val thumbService: DriveThumbService,
    private val zipService: DriveZipService,
    private val redis: RedisService,
    private val uploadConfig: UploadConfig,
) {

    @GetMapping("/{token}")
    fun landing(
        @PathVariable token: String,
        @RequestParam(required = false) dir: String?,
        request: HttpServletRequest,
    ): ResponseEntity<Any> {
        val (share, node) = shareService.resolve(token)
        val authed = passwordOk(request, share, token)
        val accept = request.getHeader("Accept") ?: ""
        val wantsJson = accept.contains("application/json")

        if (node.type == "folder") {
            return folderLanding(share, node, token, authed, dir, wantsJson)
        }

        if (wantsJson) {
            val body = mapOf(
                "name" to node.name,
                "size" to (node.size ?: 0),
                "type" to node.type,
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

    /**
     * Visitor page for a shared folder: a server-rendered listing with
     * breadcrumbs scoped to the share root, per-file download/preview links,
     * image thumbnails, and a zip-all button. Navigation inside the share uses
     * ?dir=<id>; every id is validated as an active descendant of the share
     * root (resolveChild).
     */
    private fun folderLanding(
        share: DriveShare,
        root: DriveNode,
        token: String,
        authed: Boolean,
        dirParam: String?,
        wantsJson: Boolean,
    ): ResponseEntity<Any> {
        var display = root
        // Only honour ?dir= once unlocked — a locked share reveals nothing but its name.
        if (!dirParam.isNullOrEmpty() && authed) {
            val dirId = dirParam.toLongOrNull() ?: 0
            if (dirId <= 0) throw NotFoundException("not found")
            val n = shareService.resolveChild(root.id, dirId)
            if (n.type != "folder") throw NotFoundException("not found")
            display = n
        }

        var children = emptyList<DriveNode>()
        var crumbs = emptyList<DriveBreadcrumb>()
        if (authed) {
            children = driveService.list(display.id, null, "name", "asc")
            crumbs = driveService.breadcrumbs(display.id)
            // Scope the chain to the share root — never leak ancestors above it.
            val i = crumbs.indexOfFirst { it.id == root.id }
            if (i >= 0) crumbs = crumbs.subList(i, crumbs.size)
        }

        if (wantsJson) {
            val body = linkedMapOf<String, Any?>(
                "name" to root.name,
                "size" to 0L,
                "type" to root.type,
                "mime_type" to "",
                "has_password" to !share.passwordHash.isNullOrEmpty(),
                "authed" to authed,
                "expires_at" to share.expiresAt,
            )
            if (authed) {
                body["dir"] = mapOf("id" to display.id, "name" to display.name)
                body["breadcrumbs"] = crumbs.map { mapOf("id" to it.id, "name" to it.name) }
                body["children"] = children.map {
                    mapOf(
                        "id" to it.id,
                        "name" to it.name,
                        "type" to it.type,
                        "size" to (it.size ?: 0),
                        "mime_type" to (it.mimeType ?: ""),
                    )
                }
            }
            return ResponseEntity.ok().contentType(MediaType.APPLICATION_JSON).body(body)
        }

        val html = renderFolderLanding(
            rootName = root.name,
            hasPassword = !share.passwordHash.isNullOrEmpty(),
            authed = authed,
            token = token,
            crumbs = crumbs,
            children = children,
            dirId = if (display.id != root.id) display.id else 0L,
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
    fun download(
        @PathVariable token: String,
        @RequestParam(required = false) id: String?,
        request: HttpServletRequest,
        @RequestHeader(value = HttpHeaders.RANGE, required = false) range: String?,
    ): ResponseEntity<StreamingResponseBody> =
        serveShared(token, request, true, range, id)

    @GetMapping("/{token}/preview")
    fun preview(
        @PathVariable token: String,
        @RequestParam(required = false) id: String?,
        request: HttpServletRequest,
        @RequestHeader(value = HttpHeaders.RANGE, required = false) range: String?,
    ): ResponseEntity<StreamingResponseBody> =
        serveShared(token, request, false, range, id)

    /** Streams the shared folder (or a ?dir= subfolder of it) as a zip archive. */
    @GetMapping("/{token}/zip")
    fun zip(
        @PathVariable token: String,
        @RequestParam(required = false) dir: String?,
        request: HttpServletRequest,
    ): ResponseEntity<StreamingResponseBody> {
        val (share, node) = shareService.resolve(token)
        if (!share.passwordHash.isNullOrEmpty() && !passwordOk(request, share, token)) {
            return ResponseEntity.status(303)
                .header(HttpHeaders.LOCATION, "/shared-files/$token")
                .build<StreamingResponseBody>()
        }
        var target = node
        if (!dir.isNullOrEmpty()) {
            val dirId = dir.toLongOrNull() ?: 0
            if (dirId <= 0) throw NotFoundException("not found")
            target = shareService.resolveChild(node.id, dirId)
        }
        if (target.type != "folder") throw NotFoundException("not found")
        val folderId = target.id
        val body = StreamingResponseBody { out -> zipService.zipFolder(folderId, out) }
        return ResponseEntity.ok()
            .header(HttpHeaders.CONTENT_TYPE, "application/zip")
            .header(
                HttpHeaders.CONTENT_DISPOSITION,
                "attachment; filename*=UTF-8''${urlEncode(target.name)}.zip",
            )
            .header("X-Content-Type-Options", "nosniff")
            .body(body)
    }

    /**
     * Serves an image thumbnail for a file inside a shared folder. Reuses the
     * lazily-generated disk cache from the authenticated thumb endpoint.
     */
    @GetMapping("/{token}/thumb")
    fun thumb(
        @PathVariable token: String,
        @RequestParam(required = false) id: String?,
        request: HttpServletRequest,
    ): ResponseEntity<StreamingResponseBody> {
        val (share, node) = shareService.resolve(token)
        // Plain 401 (not a redirect): the consumer is an <img>, not a navigation.
        if (!share.passwordHash.isNullOrEmpty() && !passwordOk(request, share, token)) {
            throw AuthenticationException("unauthorized")
        }
        val targetId = id?.toLongOrNull() ?: 0
        if (targetId <= 0) throw NotFoundException("not found")
        shareService.resolveChild(node.id, targetId)
        val file = try {
            thumbService.thumbnail(targetId)
        } catch (_: BadRequestException) {
            // Non-image → 404 on the public surface.
            throw NotFoundException("not found")
        }
        val body = StreamingResponseBody { out -> file.inputStream().use { it.copyTo(out) } }
        return ResponseEntity.ok()
            .header(HttpHeaders.CONTENT_TYPE, "image/jpeg")
            .header(HttpHeaders.CONTENT_LENGTH, file.length().toString())
            .header(HttpHeaders.CACHE_CONTROL, "private, max-age=86400")
            .body(body)
    }

    private fun serveShared(
        token: String,
        request: HttpServletRequest,
        forceAttachment: Boolean,
        range: String?,
        idParam: String?,
    ): ResponseEntity<StreamingResponseBody> {
        val (share, node) = shareService.resolve(token)
        if (!share.passwordHash.isNullOrEmpty() && !passwordOk(request, share, token)) {
            return ResponseEntity.status(303)
                .header(HttpHeaders.LOCATION, "/shared-files/$token")
                .build<StreamingResponseBody>()
        }
        // Folder shares address their files via ?id= (validated as an active
        // descendant of the share root). A bare folder root has no blob to serve.
        var target = node
        if (!idParam.isNullOrEmpty()) {
            val id = idParam.toLongOrNull() ?: 0
            if (id <= 0) throw NotFoundException("not found")
            target = shareService.resolveChild(node.id, id)
        }
        val blobPath = target.blobPath
        if (target.type != "file" || blobPath.isNullOrBlank()) throw NotFoundException("not found")
        val abs = File(driveService.blobAbsPath(blobPath))
        // Shares are accessed by third parties — keep HTML as attachment to avoid XSS.
        return driveFileResponse(uploadConfig, abs, blobPath, target.name, target.mimeType, forceAttachment, range)
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

        private const val FOLDER_GLYPH =
            """<span class="glyph"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d99c2b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></span>"""
        private const val FILE_GLYPH =
            """<span class="glyph"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#8a8f98" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></span>"""
        private const val DOWNLOAD_ICON =
            """<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>"""

        private fun childRow(c: DriveNode, t: String): String {
            val isFolder = c.type == "folder"
            val mt = c.mimeType ?: ""
            val isImage = !isFolder && mt.startsWith("image/")
            // Anything safe to serve inline opens in a browser tab; the rest
            // links straight to download.
            val canPreview = !isFolder && !DriveApiController.mustForceAttachment(mt, c.ext ?: "")
            val glyph = when {
                isImage ->
                    """<img class="thumb" loading="lazy" src="/shared-files/$t/thumb?id=${c.id}" onerror="this.style.display='none'" alt="" />"""
                isFolder -> FOLDER_GLYPH
                else -> FILE_GLYPH
            }
            val nameLink = when {
                isFolder -> """<a class="name" href="/shared-files/$t?dir=${c.id}">${esc(c.name)}</a>"""
                canPreview -> """<a class="name" href="/shared-files/$t/preview?id=${c.id}" target="_blank" rel="noopener">${esc(c.name)}</a>"""
                else -> """<a class="name" href="/shared-files/$t/download?id=${c.id}">${esc(c.name)}</a>"""
            }
            val size = if (isFolder) "—" else humanSize(c.size ?: 0)
            val dl = if (isFolder) "" else
                """<a class="dl" href="/shared-files/$t/download?id=${c.id}" title="Download">$DOWNLOAD_ICON</a>"""
            return """<li class="row">$glyph$nameLink<span class="sz">$size</span>$dl</li>"""
        }

        /**
         * The visitor page for shared folders: breadcrumbs scoped to the share
         * root, a child listing with thumbnails for images, and per-file
         * preview/download links. Kept as a plain server-rendered page (no JS)
         * in the same style as the single-file landing above.
         */
        fun renderFolderLanding(
            rootName: String,
            hasPassword: Boolean,
            authed: Boolean,
            token: String,
            crumbs: List<DriveBreadcrumb>,
            children: List<DriveNode>,
            dirId: Long,
        ): String {
            val t = esc(token)
            val content = if (hasPassword && !authed) {
                """<h1>${esc(rootName)}</h1>
<p class="size">Folder</p>
<form method="post" action="/shared-files/$t/auth">
  <input type="password" name="password" placeholder="Password" autofocus required />
  <button type="submit">Unlock</button>
</form>"""
            } else {
                val crumbHtml = crumbs.mapIndexed { i, c ->
                    val sep = if (i > 0) """<span class="sep">/</span>""" else ""
                    val item = when {
                        i == crumbs.size - 1 -> """<span class="cur">${esc(c.name)}</span>"""
                        i == 0 -> """<a href="/shared-files/$t">${esc(c.name)}</a>"""
                        else -> """<a href="/shared-files/$t?dir=${c.id}">${esc(c.name)}</a>"""
                    }
                    sep + item
                }.joinToString("")
                val listing = if (children.isEmpty()) {
                    """<p class="empty">This folder is empty</p>"""
                } else {
                    "<ul class=\"rows\">\n" + children.joinToString("\n") { childRow(it, t) } + "\n</ul>"
                }
                val zipHref = if (dirId > 0) "/shared-files/$t/zip?dir=$dirId" else "/shared-files/$t/zip"
                """<nav class="crumbs">$crumbHtml</nav>
$listing
<div class="actions">
  <a class="btn" href="$zipHref">Download all (.zip)</a>
</div>"""
            }
            return """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(rootName)} · Mote Drive</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         display:flex; align-items:flex-start; justify-content:center; min-height:100vh;
         background:#fafafa; margin:0; padding:32px 16px; box-sizing:border-box; color:#1a1a1a; }
  .card { background:#fff; padding:24px 28px; border-radius:14px; box-shadow:0 4px 24px rgba(0,0,0,.06);
          max-width:720px; width:100%; box-sizing:border-box; }
  h1 { font-size:18px; margin:0 0 4px; word-break:break-all; }
  p.size { color:#888; margin:0 0 24px; font-size:13px; }
  .crumbs { font-size:14px; margin:0 0 14px; color:#888; word-break:break-all; }
  .crumbs a { color:#2563eb; text-decoration:none; }
  .crumbs a:hover { text-decoration:underline; }
  .crumbs .sep { margin:0 6px; color:#ccc; }
  .crumbs .cur { color:#1a1a1a; font-weight:500; }
  ul.rows { list-style:none; margin:0 0 20px; padding:0; border-top:1px solid #f0f0f0; }
  li.row { display:flex; align-items:center; gap:12px; padding:9px 4px; border-bottom:1px solid #f0f0f0; }
  li.row:hover { background:#fafafa; }
  .glyph { width:36px; height:36px; display:flex; align-items:center; justify-content:center;
           background:#f5f5f5; border-radius:8px; flex-shrink:0; }
  img.thumb { width:36px; height:36px; object-fit:cover; border-radius:8px; flex-shrink:0; background:#f5f5f5; }
  a.name { flex:1; min-width:0; color:#1a1a1a; text-decoration:none; font-size:14px;
           overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  a.name:hover { color:#2563eb; }
  .sz { color:#999; font-size:12px; flex-shrink:0; min-width:64px; text-align:right; }
  a.dl { display:flex; padding:6px; border-radius:6px; color:#666; flex-shrink:0; }
  a.dl:hover { background:#eee; color:#1a1a1a; }
  .actions { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
  a.btn, button { display:inline-block; padding:10px 18px; border-radius:8px; background:#111;
           color:#fff; text-decoration:none; border:0; cursor:pointer; font-size:14px; }
  input[type=password] { width:100%; padding:10px 12px; border:1px solid #ddd; border-radius:8px;
           font-size:14px; box-sizing:border-box; margin-bottom:12px; }
  form { margin-top:8px; }
  .empty { color:#999; font-size:14px; padding:24px 0; text-align:center; }
  .meta { color:#666; font-size:13px; margin-top:18px; }
</style></head><body>
<div class="card">$content
<p class="meta">Shared via Mote Drive</p></div></body></html>"""
        }
    }
}
