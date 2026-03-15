package site.daydream.mote.controller

import com.fasterxml.jackson.databind.ObjectMapper
import io.github.cymoo.colleen.BadRequest
import io.github.cymoo.colleen.Context
import io.github.cymoo.colleen.Controller
import io.github.cymoo.colleen.Get
import io.github.cymoo.colleen.Json
import io.github.cymoo.colleen.Param
import io.github.cymoo.colleen.Query
import io.github.cymoo.colleen.Result
import io.github.cymoo.colleen.UploadedFile
import site.daydream.mote.config.AppConfig
import site.daydream.mote.exception.AuthenticationException
import site.daydream.mote.exception.NotFoundException
import site.daydream.mote.model.*
import site.daydream.mote.service.*
import java.time.LocalDate
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import kotlin.math.abs

@Controller("/")
class PostApiController {

    @io.github.cymoo.colleen.Post("/login")
    fun login(body: Json<LoginRequest>, authService: AuthService): Result<Unit> {
        if (!authService.isValidToken(body.value.password)) {
            throw AuthenticationException("invalid password")
        }
        return Result.noContent()
    }

    @Get("/auth")
    fun auth(): Result<Unit> = Result.noContent()

    @Get("/get-tags")
    fun getTags(tagService: TagService): List<TagWithPostCount> {
        return tagService.getAllWithPostCount()
    }

    @io.github.cymoo.colleen.Post("/rename-tag")
    fun renameTag(body: Json<RenameTagRequest>, tagService: TagService): Result<Unit> {
        tagService.renameOrMerge(body.value.name, body.value.newName)
        return Result.noContent()
    }

    @io.github.cymoo.colleen.Post("/delete-tag")
    fun deleteTag(body: Json<Name>, tagService: TagService): Result<Unit> {
        tagService.deleteAssociatedPosts(name = body.value.name)
        return Result.noContent()
    }

    @io.github.cymoo.colleen.Post("/stick-tag")
    fun stickTag(body: Json<StickyTagRequest>, tagService: TagService): Result<Unit> {
        tagService.insertOrUpdate(body.value.name, body.value.sticky)
        return Result.noContent()
    }

    @io.github.cymoo.colleen.Post("/create-post")
    fun createPost(body: Json<CreatePostRequest>, postService: PostService, taskService: TaskService, ctx: Context): Result<CreateResponse> {
        val payload = body.value
        val objectMapper = ctx.getService<ObjectMapper>()
        val response = postService.create(
            Post(
                content = payload.content,
                files = payload.files?.let { objectMapper.writeValueAsString(it) },
                shared = payload.shared ?: false,
                parentId = payload.parentId,
                color = payload.color?.toString()?.lowercase()
            )
        )
        taskService.buildIndex(response.id, payload.content)
        return Result.created(response)
    }

    @io.github.cymoo.colleen.Post("/update-post")
    fun updatePost(body: Json<UpdatePostRequest>, postService: PostService, taskService: TaskService): Result<Unit> {
        val payload = body.value
        val post = postService.findById(payload.id)
        if (post == null || post.deletedAt != null) {
            throw NotFoundException("Post not found")
        }

        postService.update(payload)
        payload.content?.let {
            if (post.content != it) {
                taskService.rebuildIndex(payload.id, it)
            }
        }
        return Result.noContent()
    }

    @io.github.cymoo.colleen.Post("/delete-post")
    fun deletePost(body: Json<DeletePostRequest>, postService: PostService, taskService: TaskService): Result<Unit> {
        val payload = body.value
        if (payload.hard) {
            postService.clear(payload.id)
            taskService.deleteIndex(payload.id)
        } else {
            postService.delete(payload.id)
        }
        return Result.noContent()
    }

    @io.github.cymoo.colleen.Post("/restore-post")
    fun restorePost(body: Json<Id>, postService: PostService): Result<Unit> {
        postService.restore(body.value.id)
        return Result.noContent()
    }

    @io.github.cymoo.colleen.Post("/clear-posts")
    fun clearPosts(postService: PostService, taskService: TaskService): Result<Unit> {
        val ids = postService.clearAll()
        for (id in ids) {
            taskService.deleteIndex(id)
        }
        return Result.noContent()
    }

    @Get("/search")
    fun search(
        query: Query<String>,
        limit: Query<Int?>,
        partial: Query<Boolean?>,
        searchService: SearchService,
        postService: PostService
    ): PostPagination {
        val (tokens, results) = searchService.search(
            query.value,
            partial.value ?: false,
            limit.value ?: 0
        )

        if (results.isEmpty()) {
            return PostPagination(posts = emptyList(), cursor = -1, size = 0)
        }

        val idToScore = results.associate { it.id to it.score }
        val posts = postService.findByIds(idToScore.keys.toList()).map {
            it.copy(
                score = idToScore[it.id],
                content = it.content.markTokensInHtml(tokens)
            )
        }

        return PostPagination(
            posts = posts.sortedByDescending { it.score },
            cursor = -1,
            size = results.size
        )
    }

    @Get("/get-post")
    fun getPost(id: Query<Int>, postService: PostService): Post {
        return postService.findWithParent(id.value)
    }

    @Get("/get-posts")
    fun getPosts(
        cursor: Query<Long?>,
        deleted: Query<Boolean?>,
        @Param("parent_id") parentId: Query<Int?>,
        color: Query<String?>,
        tag: Query<String?>,
        shared: Query<Boolean?>,
        @Param("has_files") hasFiles: Query<Boolean?>,
        @Param("order_by") orderBy: Query<String?>,
        ascending: Query<Boolean?>,
        @Param("start_date") startDate: Query<Long?>,
        @Param("end_date") endDate: Query<Long?>,
        postService: PostService,
        appConfig: AppConfig
    ): PostPagination {
        val filterRequest = FilterPostRequest(
            cursor = cursor.value,
            deleted = deleted.value ?: false,
            parentId = parentId.value,
            color = color.value?.let { CategoryColor.valueOf(it.uppercase()) },
            tag = tag.value,
            shared = shared.value,
            hasFiles = hasFiles.value,
            orderBy = orderBy.value?.let { SortingField.valueOf(it.uppercase()) } ?: SortingField.CREATED_AT,
            ascending = ascending.value ?: false,
            startDate = startDate.value,
            endDate = endDate.value,
        )

        val posts = postService.filterPosts(filterRequest, appConfig.postsPerPage)
        return PostPagination(
            posts = posts,
            cursor = if (posts.isEmpty()) -1 else posts.last().createdAt,
            size = posts.size,
        )
    }

    @Get("/get-overall-counts")
    fun getStats(postService: PostService, tagService: TagService): PostStats {
        return PostStats(
            postCount = postService.getCount(),
            tagCount = tagService.getCount(),
            dayCount = postService.getActiveDays()
        )
    }

    @Get("/get-daily-post-counts")
    fun getDailyPostCounts(
        @Param("start_date") startDate: Query<String>,
        @Param("end_date") endDate: Query<String>,
        offset: Query<Int?>,
        postService: PostService
    ): List<Int> {
        val utcOffset = offset.value ?: 480
        return postService.getDailyCounts(
            startDate = startDate.value.toZonedDateTime(utcOffset),
            endDate = endDate.value.toZonedDateTime(utcOffset, endOfDay = true)
        )
    }

    @Get("/upload")
    fun showFile(): String = """
        <!doctype html>
        <html>
            <head><title>Upload file</title></head>
            <body>
                <form action="upload" method="post" enctype="multipart/form-data">
                    <input type="file" name="file" multiple>
                    <button type="submit">Upload</button>
                </form>
            </body>
        </html>
    """.trimIndent()

    @io.github.cymoo.colleen.Post("/upload")
    fun uploadFile(file: UploadedFile, uploadService: UploadService): FileInfo {
        val item = file.value ?: throw BadRequest("File is required")
        return uploadService.handleFileUpload(
            filename = item.filename,
            contentType = item.contentType,
            inputStream = item.inputStream
        )
    }

    @Get("/_dangerously_rebuild_all_indexes")
    fun rebuildIndexes(taskService: TaskService): Map<String, String> {
        taskService.rebuildAllIndexes()
        return mapOf("msg" to "ok")
    }
}

// Helper functions

fun Char.isChineseCharacter(): Boolean {
    return this in '\u4e00'..'\u9fff'
}

fun String.markTokensInHtml(tokens: List<String>): String {
    if (tokens.isEmpty()) return this

    val patterns = tokens
        .sortedByDescending { it.length }
        .map { token ->
            if (token.any { it.isChineseCharacter() }) {
                Regex.escape(token)
            } else {
                "\\b${Regex.escape(token)}\\b"
            }
        }

    val pattern = Regex("<[^>]*>|(${patterns.joinToString("|")})")

    return pattern.replace(this) { matchResult ->
        matchResult.groups[1]?.let { "<mark>${it.value}</mark>" } ?: matchResult.value
    }
}

fun String.toZonedDateTime(utcOffset: Int, endOfDay: Boolean = false): ZonedDateTime {
    require(abs(utcOffset) <= 1440) {
        "Timezone offset must be between -1440 and 1440 minutes: $utcOffset"
    }

    val localDate = LocalDate.parse(this, DateTimeFormatter.ofPattern("yyyy-MM-dd"))

    val localDateTime = if (endOfDay) {
        localDate.atTime(23, 59, 59, 999_000_000)
    } else {
        localDate.atStartOfDay()
    }

    val zoneOffset = ZoneOffset.ofTotalSeconds(utcOffset * 60)
    return localDateTime.atZone(zoneOffset)
}
