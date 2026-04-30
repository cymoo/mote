package site.daydream.mote.controller

import com.fasterxml.jackson.databind.ObjectMapper
import jakarta.servlet.http.HttpServletRequest
import jakarta.validation.Valid
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.*
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody
import site.daydream.mote.annotation.AuthRequired
import site.daydream.mote.exception.BadRequestException
import site.daydream.mote.exception.NotFoundException
import site.daydream.mote.model.*
import site.daydream.mote.service.DriveService
import site.daydream.mote.service.DriveShareService
import site.daydream.mote.service.DriveThumbService
import site.daydream.mote.service.DriveUploadService
import site.daydream.mote.service.DriveZipService
import java.io.File
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

@RestController
@RequestMapping("/api/drive")
@AuthRequired(true)
class DriveController(
    private val driveService: DriveService,
    private val uploadService: DriveUploadService,
    private val shareService: DriveShareService,
    private val thumbService: DriveThumbService,
    private val zipService: DriveZipService,
) {

    @GetMapping("/list")
    fun list(
        @RequestParam("parent_id", required = false) parentId: Long?,
        @RequestParam(required = false) q: String?,
        @RequestParam("order_by", required = false) orderBy: String?,
        @RequestParam(required = false) sort: String?,
    ): List<DriveNode> = driveService.list(parentId, q, orderBy, sort)

    @GetMapping("/breadcrumbs")
    fun breadcrumbs(@RequestParam id: Long): List<DriveBreadcrumb> = driveService.breadcrumbs(id)

    @GetMapping("/trash")
    fun trash(): List<DriveNode> = driveService.listTrash()

    @PostMapping("/folder")
    fun createFolder(@RequestBody @Valid req: DriveCreateFolderRequest): DriveNode =
        driveService.createFolder(req.parentId, req.name)

    @PostMapping("/rename")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun rename(@RequestBody @Valid req: DriveRenameRequest) {
        driveService.rename(req.id, req.name)
    }

    @PostMapping("/move")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun move(@RequestBody @Valid req: DriveMoveRequest) {
        driveService.move(req.ids, req.newParentId)
    }

    @PostMapping("/delete")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun delete(@RequestBody @Valid req: DriveDeleteRequest) {
        driveService.softDelete(req.ids)
    }

    @PostMapping("/restore")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun restore(@RequestBody @Valid req: DriveRestoreRequest) {
        driveService.restore(req.id)
    }

    @PostMapping("/purge")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun purge(@RequestBody @Valid req: DrivePurgeRequest) {
        driveService.purge(req.ids)
    }

    @GetMapping("/download")
    fun download(@RequestParam id: Long): ResponseEntity<StreamingResponseBody> = serveBlob(id, true)

    @GetMapping("/preview")
    fun preview(@RequestParam id: Long): ResponseEntity<StreamingResponseBody> = serveBlob(id, false)

    @GetMapping("/thumb")
    fun thumb(
        @RequestParam id: Long,
        @RequestHeader(value = HttpHeaders.IF_NONE_MATCH, required = false) ifNoneMatch: String?,
    ): ResponseEntity<StreamingResponseBody> {
        val node = driveService.findByIdOrNull(id)
            ?: throw NotFoundException("not found")
        if (node.type != "file" || node.deletedAt != null) throw NotFoundException("not found")
        val etag = "\"${node.hash ?: node.id.toString()}\""
        if (ifNoneMatch != null && ifNoneMatch.split(",").any { it.trim() == etag }) {
            return ResponseEntity.status(HttpStatus.NOT_MODIFIED)
                .eTag(etag)
                .header(HttpHeaders.CACHE_CONTROL, "private, max-age=0, must-revalidate")
                .build()
        }
        val file = thumbService.thumbnail(id)
        val body = StreamingResponseBody { out -> file.inputStream().use { it.copyTo(out) } }
        return ResponseEntity.ok()
            .eTag(etag)
            .header(HttpHeaders.CACHE_CONTROL, "private, max-age=0, must-revalidate")
            .header(HttpHeaders.CONTENT_TYPE, "image/jpeg")
            .header(HttpHeaders.CONTENT_LENGTH, file.length().toString())
            .body(body)
    }

    @GetMapping("/download-zip")
    fun downloadZip(@RequestParam id: Long): ResponseEntity<StreamingResponseBody> {
        val node = driveService.findById(id)
        if (node.type != "folder" || node.deletedAt != null) throw NotFoundException("not found")
        val body = StreamingResponseBody { out -> zipService.zipFolder(id, out) }
        return ResponseEntity.ok()
            .header(HttpHeaders.CONTENT_TYPE, "application/zip")
            .header(
                HttpHeaders.CONTENT_DISPOSITION,
                "attachment; filename*=UTF-8''${urlEncode(node.name)}.zip",
            )
            .header("X-Content-Type-Options", "nosniff")
            .body(body)
    }

    private fun serveBlob(id: Long, forceAttachment: Boolean): ResponseEntity<StreamingResponseBody> {
        val node = driveService.findById(id)
        if (node.type != "file" || node.blobPath.isNullOrBlank() || node.deletedAt != null) {
            throw NotFoundException("not found")
        }
        val abs = File(driveService.blobAbsPath(node.blobPath))
        if (!abs.exists()) throw NotFoundException("not found")

        val mt = node.mimeType ?: "application/octet-stream"
        val disp = if (forceAttachment || mustForceAttachment(mt, node.ext ?: "")) "attachment" else "inline"

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

    // ---------- uploads ----------

    @PostMapping("/upload/init")
    fun uploadInit(@RequestBody @Valid req: DriveUploadInitRequest): DriveUploadInitResponse {
        val u = uploadService.init(req)
        return DriveUploadInitResponse(
            uploadId = u.id, totalChunks = u.totalChunks, chunkSize = u.chunkSize, receivedChunks = emptyList(),
        )
    }

    @GetMapping("/upload/{uploadId}")
    fun uploadStatus(@PathVariable uploadId: String): DriveUploadStatusResponse {
        val (u, received) = uploadService.get(uploadId)
        return DriveUploadStatusResponse(
            uploadId = u.id, totalChunks = u.totalChunks, chunkSize = u.chunkSize, size = u.size,
            receivedChunks = received, status = u.status,
        )
    }

    @PutMapping("/upload/chunk/{uploadId}/{idx}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun uploadChunk(
        @PathVariable uploadId: String,
        @PathVariable idx: Int,
        request: HttpServletRequest,
    ) {
        request.inputStream.use { uploadService.putChunk(uploadId, idx, it) }
    }

    @PostMapping("/upload/complete")
    fun uploadComplete(@RequestBody @Valid req: DriveUploadCompleteRequest): DriveNode {
        val policy = req.onCollision.ifBlank { "ask" }
        return uploadService.complete(req.uploadId, policy)
    }

    @DeleteMapping("/upload/{uploadId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun uploadCancel(@PathVariable uploadId: String) {
        uploadService.cancel(uploadId)
    }

    // ---------- shares ----------

    @PostMapping("/share")
    fun createShare(@RequestBody @Valid req: DriveShareCreateRequest, request: HttpServletRequest): DriveShareDto {
        val (sh, token) = shareService.create(req.nodeId, req.password, req.expiresAt)
        return toShareDto(sh, token, shareUrl(request, token))
    }

    @GetMapping("/shares")
    fun listShares(@RequestParam id: Long): List<DriveShareDto> =
        shareService.listByNode(id).map { toShareDto(it, null, null) }

    @GetMapping("/shares/all")
    fun listAllShares(@RequestParam(name = "include_expired", defaultValue = "false") includeExpired: Boolean):
            List<DriveSharedItemDto> = shareService.listAll(includeExpired).map {
        DriveSharedItemDto(
            id = it.share.id,
            nodeId = it.share.nodeId,
            parentId = it.parentId,
            hasPassword = !it.share.passwordHash.isNullOrEmpty(),
            expiresAt = it.share.expiresAt,
            createdAt = it.share.createdAt,
            name = it.name,
            size = it.size,
            path = it.path,
        )
    }

    @PostMapping("/share/revoke")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun revokeShare(@RequestBody @Valid req: DriveShareRevokeRequest) {
        shareService.revoke(req.shareId)
    }

    // ---------- helpers ----------

    private fun toShareDto(sh: DriveShare, token: String?, url: String?) = DriveShareDto(
        id = sh.id,
        nodeId = sh.nodeId,
        hasPassword = !sh.passwordHash.isNullOrEmpty(),
        expiresAt = sh.expiresAt,
        createdAt = sh.createdAt,
        url = url,
        token = token,
    )

    private fun shareUrl(req: HttpServletRequest, token: String): String {
        val proto = req.getHeader("X-Forwarded-Proto")?.takeIf { it.isNotBlank() } ?: req.scheme ?: "http"
        val host = req.getHeader("X-Forwarded-Host")?.takeIf { it.isNotBlank() } ?: req.getHeader("Host") ?: "localhost"
        return "$proto://$host/shared-files/$token"
    }

    companion object {
        fun urlEncode(s: String): String =
            URLEncoder.encode(s, StandardCharsets.UTF_8).replace("+", "%20")

        fun mustForceAttachment(mt: String, ext: String): Boolean {
            val mtl = mt.lowercase()
            val e = ext.lowercase().removePrefix(".")
            if (e in INLINE_UNSAFE_EXT) return true
            if (mtl.startsWith("text/html") || mtl.contains("javascript") || mtl.startsWith("image/svg")) return true
            if (mtl.isEmpty() || mtl == "application/octet-stream") return true
            return false
        }

        private val INLINE_UNSAFE_EXT = setOf("html", "htm", "svg", "xhtml", "xml", "js", "mjs")
    }
}
