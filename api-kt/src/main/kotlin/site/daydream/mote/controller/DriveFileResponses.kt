package site.daydream.mote.controller

import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody
import site.daydream.mote.config.UploadConfig
import site.daydream.mote.exception.NotFoundException
import java.io.File
import java.io.RandomAccessFile
import kotlin.math.min

fun driveFileResponse(
    uploadConfig: UploadConfig,
    abs: File,
    blobPath: String,
    name: String,
    mimeType: String?,
    forceAttachment: Boolean,
    rangeHeader: String?,
): ResponseEntity<StreamingResponseBody> {
    val mt = mimeType ?: "application/octet-stream"
    val ext = File(name).extension
    val disp = if (forceAttachment || DriveApiController.mustForceAttachment(mt, ext)) "attachment" else "inline"
    val accelUri = driveAccelRedirectUri(uploadConfig, blobPath)
    if (!abs.exists() || abs.isDirectory) throw NotFoundException("not found")

    if (accelUri != null) {
        // nginx replaces the body; return an empty body so Spring can serialize it
        return responseBuilder(HttpStatus.OK, mt, disp, name)
            .header("X-Accel-Redirect", accelUri)
            .body(StreamingResponseBody { })
    }

    val range = parseRange(rangeHeader, abs.length())
    val contentLength = range?.let { it.last - it.first + 1 } ?: abs.length()
    val body: StreamingResponseBody = StreamingResponseBody { out ->
        RandomAccessFile(abs, "r").use { file ->
            range?.let { file.seek(it.first) }
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            var remaining = contentLength
            while (remaining > 0) {
                val read = file.read(buffer, 0, min(buffer.size.toLong(), remaining).toInt())
                if (read < 0) break
                out.write(buffer, 0, read)
                remaining -= read
            }
        }
    }
    val status = if (range != null) HttpStatus.PARTIAL_CONTENT else HttpStatus.OK
    return responseBuilder(status, mt, disp, name)
        .header(HttpHeaders.ACCEPT_RANGES, "bytes")
        .header(HttpHeaders.CONTENT_LENGTH, contentLength.toString())
        .apply {
            if (range != null) header(HttpHeaders.CONTENT_RANGE, "bytes ${range.first}-${range.last}/${abs.length()}")
        }
        .body(body)
}

private fun responseBuilder(
    status: HttpStatus,
    mimeType: String,
    disposition: String,
    name: String,
): ResponseEntity.BodyBuilder =
    ResponseEntity.status(status)
        .header(HttpHeaders.CONTENT_TYPE, mimeType)
        .header(HttpHeaders.CONTENT_DISPOSITION, "$disposition; filename*=UTF-8''${DriveApiController.urlEncode(name)}")
        .header("X-Content-Type-Options", "nosniff")

private fun parseRange(rangeHeader: String?, fileLength: Long): LongRange? {
    if (rangeHeader.isNullOrBlank()) return null
    if (!rangeHeader.startsWith("bytes=") || "," in rangeHeader) return null
    val spec = rangeHeader.removePrefix("bytes=").trim()
    val dash = spec.indexOf('-')
    if (dash < 0) return null

    val startPart = spec.substring(0, dash)
    val endPart = spec.substring(dash + 1)
    val start: Long
    val end: Long
    if (startPart.isBlank()) {
        val suffixLength = endPart.toLongOrNull() ?: return null
        if (suffixLength <= 0) return null
        start = maxOf(fileLength - suffixLength, 0)
        end = fileLength - 1
    } else {
        start = startPart.toLongOrNull() ?: return null
        if (start < 0 || start >= fileLength) return null
        end = endPart.toLongOrNull()?.coerceAtMost(fileLength - 1) ?: (fileLength - 1)
    }
    if (end < start) return null
    return start..end
}

private fun driveAccelRedirectUri(uploadConfig: UploadConfig, blobPath: String): String? {
    val prefix = uploadConfig.accelRedirectPrefix.trim().trimEnd('/')
    if (prefix.isBlank()) return null
    if (!prefix.startsWith('/')) throw IllegalStateException("DRIVE_ACCEL_REDIRECT_PREFIX must start with '/'")

    val parts = blobPath.replace('\\', '/').split('/')
    if (parts.size != 2 || parts[0] != "drive" || parts[1].isBlank() || parts[1] == "." || parts[1] == "..") {
        throw NotFoundException("not found")
    }
    return "$prefix/${DriveApiController.urlEncode(parts[1])}"
}
