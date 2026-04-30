package site.daydream.mote.model

import com.fasterxml.jackson.annotation.JsonIgnore
import com.fasterxml.jackson.annotation.JsonInclude
import com.fasterxml.jackson.annotation.JsonProperty
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.NotEmpty
import jakarta.validation.constraints.Positive
import java.net.URLConnection

// ---------- DB row models ----------

data class DriveNode(
    val id: Long = 0,
    @JsonProperty("parent_id")
    val parentId: Long? = null,
    val type: String = "file", // "folder" | "file"
    val name: String = "",
    @JsonIgnore
    val blobPath: String? = null,
    val size: Long? = null,
    @JsonInclude(JsonInclude.Include.NON_NULL)
    val hash: String? = null,
    @JsonProperty("deleted_at")
    @JsonInclude(JsonInclude.Include.NON_NULL)
    val deletedAt: Long? = null,
    @JsonIgnore
    val deleteBatchId: String? = null,
    @JsonProperty("created_at")
    val createdAt: Long = 0,
    @JsonProperty("updated_at")
    val updatedAt: Long = 0,

    /** slash-joined ancestor path; populated only by global search responses */
    @JsonInclude(JsonInclude.Include.NON_EMPTY)
    val path: String = "",

    /** active share count for this file node; emitted only when > 0 */
    @JsonProperty("share_count")
    @JsonInclude(JsonInclude.Include.NON_DEFAULT)
    val shareCount: Int = 0,
) {
    val ext: String?
        @JsonProperty("ext")
        get() = if (type != "file") null
        else {
            val n = name
            val i = n.lastIndexOf('.')
            if (i < 0) "" else n.substring(i).lowercase()
        }

    @get:JsonProperty("mime_type")
    val mimeType: String?
        get() {
            if (type != "file") return null
            return URLConnection.guessContentTypeFromName(name) ?: extMime(ext) ?: "application/octet-stream"
        }

    companion object {
        private fun extMime(e: String?): String? = when (e) {
            ".webp" -> "image/webp"
            ".svg" -> "image/svg+xml"
            ".md" -> "text/markdown"
            ".mjs" -> "application/javascript"
            ".json" -> "application/json"
            ".yaml", ".yml" -> "application/yaml"
            ".mp4" -> "video/mp4"
            ".webm" -> "video/webm"
            ".mp3" -> "audio/mpeg"
            ".wav" -> "audio/wav"
            ".ogg" -> "audio/ogg"
            ".zip" -> "application/zip"
            ".7z" -> "application/x-7z-compressed"
            ".tar" -> "application/x-tar"
            ".gz" -> "application/gzip"
            ".pdf" -> "application/pdf"
            else -> null
        }
    }
}

data class DriveUpload(
    val id: String = "",
    val parentId: Long? = null,
    val name: String = "",
    val size: Long = 0,
    val chunkSize: Long = 0,
    val totalChunks: Int = 0,
    val receivedMask: ByteArray = ByteArray(0),
    val status: String = "uploading",
    val expiresAt: Long = 0,
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
)

data class DriveShare(
    val id: Long = 0,
    val nodeId: Long = 0,
    val tokenHash: String = "",
    val tokenPrefix: String = "",
    val passwordHash: String? = null,
    val expiresAt: Long? = null,
    val createdAt: Long = 0,
)

data class ShareWithNode(
    val share: DriveShare,
    val name: String,
    val size: Long,
    val parentId: Long?,
    val path: String,
)

data class DriveBreadcrumb(
    val id: Long,
    val name: String,
)

// ---------- Request DTOs ----------

data class DriveCreateFolderRequest(
    @JsonProperty("parent_id")
    val parentId: Long? = null,
    @field:NotBlank
    val name: String,
)

data class DriveRenameRequest(
    @field:Positive
    val id: Long,
    @field:NotBlank
    val name: String,
)

data class DriveMoveRequest(
    @field:NotEmpty
    val ids: List<Long>,
    @JsonProperty("new_parent_id")
    val newParentId: Long? = null,
)

data class DriveDeleteRequest(
    @field:NotEmpty
    val ids: List<Long>,
)

data class DriveRestoreRequest(
    @field:Positive
    val id: Long,
)

data class DrivePurgeRequest(
    @field:NotEmpty
    val ids: List<Long>,
)

data class DriveUploadInitRequest(
    @JsonProperty("parent_id")
    val parentId: Long? = null,
    @field:NotBlank
    val name: String,
    @field:Positive
    val size: Long,
    @JsonProperty("chunk_size")
    val chunkSize: Long = 0,
)

data class DriveUploadCompleteRequest(
    @JsonProperty("upload_id")
    @field:NotBlank
    val uploadId: String,
    @JsonProperty("on_collision")
    val onCollision: String = "ask", // ask|overwrite|rename|skip
)

data class DriveShareCreateRequest(
    @JsonProperty("node_id")
    @field:Positive
    val nodeId: Long,
    val password: String? = null,
    @JsonProperty("expires_at")
    val expiresAt: Long? = null,
)

data class DriveShareRevokeRequest(
    @JsonProperty("share_id")
    @field:Positive
    val shareId: Long,
)

// ---------- Response DTOs ----------

data class DriveUploadInitResponse(
    @JsonProperty("upload_id") val uploadId: String,
    @JsonProperty("total_chunks") val totalChunks: Int,
    @JsonProperty("chunk_size") val chunkSize: Long,
    @JsonProperty("received_chunks") val receivedChunks: List<Int>,
)

data class DriveUploadStatusResponse(
    @JsonProperty("upload_id") val uploadId: String,
    @JsonProperty("total_chunks") val totalChunks: Int,
    @JsonProperty("chunk_size") val chunkSize: Long,
    val size: Long,
    @JsonProperty("received_chunks") val receivedChunks: List<Int>,
    val status: String,
)

data class DriveShareDto(
    val id: Long,
    @JsonProperty("node_id") val nodeId: Long,
    @JsonProperty("has_password") val hasPassword: Boolean,
    @JsonProperty("expires_at") val expiresAt: Long?,
    @JsonProperty("created_at") val createdAt: Long,
    @JsonInclude(JsonInclude.Include.NON_NULL)
    val url: String? = null,
    @JsonInclude(JsonInclude.Include.NON_NULL)
    val token: String? = null,
)

data class DriveSharedItemDto(
    val id: Long,
    @JsonProperty("node_id") val nodeId: Long,
    @JsonProperty("parent_id") val parentId: Long?,
    @JsonProperty("has_password") val hasPassword: Boolean,
    @JsonProperty("expires_at") val expiresAt: Long?,
    @JsonProperty("created_at") val createdAt: Long,
    val name: String,
    val size: Long,
    val path: String,
)
