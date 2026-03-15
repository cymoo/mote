package site.daydream.mote.model

import com.fasterxml.jackson.annotation.JsonIgnore
import com.fasterxml.jackson.annotation.JsonInclude
import com.fasterxml.jackson.annotation.JsonRawValue
import com.fasterxml.jackson.core.JsonGenerator
import com.fasterxml.jackson.databind.JsonSerializer
import com.fasterxml.jackson.databind.SerializerProvider
import com.fasterxml.jackson.databind.annotation.JsonSerialize
import java.time.Instant

data class Post(
    val id: Int? = null,
    val content: String,

    @get:JsonSerialize(nullsUsing = DefaultEmptyListSerializer::class)
    @get:JsonRawValue
    val files: String? = null,

    val color: String? = null,
    val shared: Boolean = false,

    @get:JsonInclude(JsonInclude.Include.NON_NULL)
    val deletedAt: Long? = null,

    val createdAt: Long = Instant.now().toEpochMilli(),
    val updatedAt: Long = Instant.now().toEpochMilli(),

    @get:JsonIgnore
    val parentId: Int? = null,

    val childrenCount: Int = 0,

    @get:JsonInclude(JsonInclude.Include.NON_NULL)
    val score: Double? = null,

    @get:JsonInclude(JsonInclude.Include.NON_NULL)
    var parent: Post? = null,

    @get:JsonInclude(JsonInclude.Include.NON_NULL)
    var tags: List<String>? = null
)

enum class CategoryColor { RED, BLUE, GREEN }

enum class SortingField { CREATED_AT, UPDATED_AT, DELETED_AT }

data class Id(val id: Int)

data class Name(val name: String) {
    init {
        require(name.isNotBlank()) { "'name' cannot be empty" }
    }
}

data class LoginRequest(val password: String) {
    init {
        require(password.isNotBlank()) { "'password' cannot be empty" }
    }
}

data class FileInfo(
    val url: String,
    val thumbUrl: String?,
    val size: Long?,
    val width: Int?,
    val height: Int?
)

data class SearchRequest(
    val query: String,
    val limit: Int = 0,
    val partial: Boolean = false,
) {
    init {
        require(query.isNotBlank()) { "'query' cannot be empty" }
    }
}

data class FilterPostRequest(
    val cursor: Long? = null,
    val deleted: Boolean = false,
    val parentId: Int? = null,
    val color: CategoryColor? = null,
    val tag: String? = null,
    val shared: Boolean? = null,
    val hasFiles: Boolean? = null,
    val orderBy: SortingField = SortingField.CREATED_AT,
    val ascending: Boolean = false,
    val startDate: Long? = null,
    val endDate: Long? = null,
)

data class DateRange(
    val startDate: String,
    val endDate: String,
    val offset: Int = 480,
)

data class CreatePostRequest(
    val content: String,
    val files: List<FileInfo>? = null,
    val color: CategoryColor? = null,
    val shared: Boolean? = null,
    val parentId: Int? = null,
) {
    init {
        require(content.isNotBlank()) { "'content' cannot be empty" }
    }
}

data class UpdatePostRequest(
    val id: Int,
    val content: String? = null,
    val shared: Boolean? = null,
    val files: List<FileInfo>? = null,
    val color: String? = null,
    val parentId: Int? = null,
) {
    // Track which fields were explicitly present in the JSON
    @Transient
    var presentFields: Set<String> = emptySet()

    fun isFilesPresent(): Boolean = "files" in presentFields
    fun isColorPresent(): Boolean = "color" in presentFields
    fun isParentIdPresent(): Boolean = "parent_id" in presentFields

    fun getColor(): CategoryColor? = color?.let { CategoryColor.valueOf(it.uppercase()) }
}

data class DeletePostRequest(
    val id: Int,
    val hard: Boolean = false,
)

data class RenameTagRequest(
    val name: String,
    val newName: String,
) {
    init {
        require(name.isNotBlank()) { "'name' cannot be empty" }
        require(newName.isNotBlank()) { "'new_name' cannot be empty" }
        require(!newName.contains(' ') && !newName.contains('#')) {
            "'new_name' cannot contain spaces or '#'"
        }
        require(!newName.startsWith('/') && !newName.endsWith('/')) {
            "'new_name' cannot start/end with '/'"
        }
        require(!newName.contains("//")) {
            "'new_name' cannot contain consecutive '/'"
        }
    }
}

data class StickyTagRequest(
    val name: String,
    val sticky: Boolean,
) {
    init {
        require(name.isNotBlank()) { "'name' cannot be empty" }
    }
}

data class TagWithPostCount(
    val name: String,
    val sticky: Boolean,
    val postCount: Long
)

data class Tag(
    val id: Int? = null,
    val name: String,
    val sticky: Boolean = false,
    val createdAt: Long = Instant.now().toEpochMilli(),
    val updatedAt: Long = Instant.now().toEpochMilli(),
)

data class CreateResponse(
    val id: Int,
    val createdAt: Long,
    val updatedAt: Long,
)

data class PostPagination(
    val posts: List<Post>,
    val cursor: Long,
    val size: Int,
)

data class PostStats(
    val postCount: Int,
    val tagCount: Int,
    val dayCount: Int,
)

class DefaultEmptyListSerializer : JsonSerializer<List<*>?>() {
    override fun serialize(value: List<*>?, gen: JsonGenerator, provider: SerializerProvider) {
        gen.writeStartArray()
        gen.writeEndArray()
    }
}
