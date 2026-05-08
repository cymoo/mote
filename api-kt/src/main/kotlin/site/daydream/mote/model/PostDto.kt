package site.daydream.mote.model

import com.fasterxml.jackson.annotation.JsonIgnore
import com.fasterxml.jackson.annotation.JsonInclude
import com.fasterxml.jackson.annotation.JsonRawValue
import com.fasterxml.jackson.core.JsonGenerator
import com.fasterxml.jackson.databind.JsonSerializer
import com.fasterxml.jackson.databind.SerializerProvider
import com.fasterxml.jackson.databind.annotation.JsonSerialize
import jakarta.validation.constraints.NotBlank
import org.springframework.web.bind.annotation.BindParam
import site.daydream.mote.util.maybe.MaybeMissing
import java.time.Instant

data class Post(
    val id: Int? = null,
    val content: String,

    @JsonSerialize(nullsUsing = DefaultEmptyListSerializer::class)
    @get:JsonRawValue
    val files: String? = null,

    val color: String? = null,
    val shared: Boolean = false,

    @JsonInclude(JsonInclude.Include.NON_NULL)
    val deletedAt: Long? = null,

    val createdAt: Long = Instant.now().toEpochMilli(),
    val updatedAt: Long = Instant.now().toEpochMilli(),

    @JsonIgnore
    val parentId: Int? = null,

    val childrenCount: Int = 0,

    // Search relevance score
    @JsonInclude(JsonInclude.Include.NON_NULL)
    val score: Double? = null,

    @JsonInclude(JsonInclude.Include.NON_NULL)
    var parent: Post? = null,

    @JsonInclude(JsonInclude.Include.NON_NULL)
    var tags: List<String>? = null
)

enum class CategoryColor { RED, BLUE, GREEN }

enum class SortingField { CREATED_AT, UPDATED_AT, DELETED_AT }

data class Id(
    val id: Int
)

data class Name(
    @field:NotBlank
    val name: String
)

data class LoginRequest(
    @field:NotBlank
    val password: String,
)

data class FileInfo(
    val url: String,
    val thumbUrl: String?,
    val size: Long?,
    val width: Int?,
    val height: Int?
)

data class SearchRequest(
    @field:NotBlank
    val query: String,

    val limit: Int = 0,
    val partial: Boolean = false,
)

data class FilterPostRequest(
    val cursor: Long?,
    val deleted: Boolean = false,

    // Mapping query parameters to @ModelAttribute does not respect Jackson's SNAKE_CASE naming strategy.
    @BindParam("parent_id")
    val parentId: Int?,

    val color: CategoryColor?,

    val tag: String?,
    val shared: Boolean?,

    @BindParam("has_files")
    val hasFiles: Boolean?,

    val untagged: Boolean?,

    @BindParam("order_by")
    val orderBy: SortingField = SortingField.CREATED_AT,

    val ascending: Boolean = false,

    @BindParam("start_date")
    val startDate: Long? = null,
    @BindParam("end_date")
    val endDate: Long? = null,
)

data class DateRange(
    @BindParam("start_date")
    @field:ValidDate
    val startDate: String,

    @BindParam("end_date")
    @field:ValidDate
    val endDate: String,

    val offset: Int = 480, // timezone offset in minutes
)

data class StatsRange(
    @BindParam("start_date")
    val startDate: String? = null,

    @BindParam("end_date")
    val endDate: String? = null,

    val offset: Int = 480, // timezone offset in minutes
)

data class CreatePostRequest(
    @field:NotBlank
    val content: String,

    val files: List<FileInfo>?,
    val color: CategoryColor?,
    val shared: Boolean?,
    val parentId: Int?,
)

data class UpdatePostRequest(
    val id: Int,

    val content: String?,
    val shared: Boolean?,

    val files: MaybeMissing<List<FileInfo>?>,
    val color: MaybeMissing<CategoryColor?>,
    val parentId: MaybeMissing<Int?>,
)

data class DeletePostRequest(
    val id: Int,
    val hard: Boolean = false,
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

data class StatCount(
    val name: String,
    val count: Int,
)

data class StatsSummary(
    val totalPosts: Int,
    val activeDays: Int,
    val sharedPosts: Int,
    val postsWithImages: Int,
    val untaggedPosts: Int,
    val firstPostAt: Long?,
    val lastPostAt: Long?,
    val colorCounts: List<StatCount>,
    val topTags: List<StatCount>,
)

class DefaultEmptyListSerializer : JsonSerializer<List<*>?>() {
    override fun serialize(value: List<*>?, gen: JsonGenerator, provider: SerializerProvider) {
        gen.writeStartArray()
        gen.writeEndArray() // Return an empty array [] when null
    }
}
