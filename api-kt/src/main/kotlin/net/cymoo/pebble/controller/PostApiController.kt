package net.cymoo.pebble.controller

import com.fasterxml.jackson.databind.ObjectMapper
import net.cymoo.pebble.annotation.AuthRequired
import net.cymoo.pebble.exception.AuthenticationException
import net.cymoo.pebble.exception.NotFoundException
import net.cymoo.pebble.model.*
import net.cymoo.pebble.service.*
import net.cymoo.pebble.util.highlight
import net.cymoo.pebble.util.toDateTime
import org.springframework.http.HttpStatus
import org.springframework.validation.annotation.Validated
import org.springframework.web.bind.annotation.*
import org.springframework.web.multipart.MultipartFile
import org.springframework.web.servlet.view.RedirectView


@RestController
@AuthRequired(true)
@Validated
@RequestMapping("/api")
class PostApiController(
    private val postService: PostService,
    private val tagService: TagService,
    private val uploadService: FileUploadService,
    private val searchService: SearchService,
    private val taskService: TaskService,
    private val authService: AuthService,
    private val objectMapper: ObjectMapper
) {
    @GetMapping
    @AuthRequired(false)
    fun apiDoc() = RedirectView("/swagger-ui.html")

    @GetMapping("/auth")
    fun empty() = null

    @PostMapping("/login")
    @AuthRequired(false)
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun login(@Validated @RequestBody payload: LoginRequest) {
        if (!authService.isValidToken(payload.password)) {
            throw AuthenticationException("invalid password")
        }
    }

    @GetMapping("/get-tags")
    fun getTags(): List<TagWithPostCount> {
        return tagService.getAllWithPostCount()
    }

    @PostMapping("/rename-tag")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun renameTag(@Validated @RequestBody payload: RenameTagRequest) {
        tagService.renameOrMerge(payload.name, payload.newName)
    }

    @PostMapping("/delete-tag")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun deleteTag(@Validated @RequestBody payload: Name) {
        tagService.deleteAssociatedPosts(name = payload.name)
    }

    @PostMapping("/stick-tag")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun stickTag(@RequestBody payload: StickyTagRequest) {
        tagService.insertOrUpdate(payload.name, payload.sticky)
    }

    @PostMapping("/create-post")
    fun createPost(@Validated @RequestBody payload: CreatePostRequest): CreateResponse {
        return postService.create(
            Post(
                content = payload.content,
                files = payload.files?.let { objectMapper.writeValueAsString(it) },
                shared = payload.shared ?: false,
                parentId = payload.parentId,
                color = payload.color?.toString()?.lowercase()
            )
        ).also {
            taskService.buildIndex(it.id, payload.content)
        }
    }

    @PostMapping("/update-post")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun updatePost(@Validated @RequestBody payload: UpdatePostRequest) {
        val post = postService.findById(payload.id)
        if (post == null || post.deletedAt != null) {
            throw NotFoundException("Post not found")
        }

        postService.update(payload).also {
            payload.content?.let {
                if (post.content != it) {
                    taskService.rebuildIndex(payload.id, it)
                }
            }
        }
    }

    @PostMapping("/delete-post")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun deletePost(@RequestBody payload: DeletePostRequest) {
        if (payload.hard) {
            postService.clear(payload.id)
            taskService.deleteIndex(payload.id)
        } else {
            postService.delete(payload.id)
        }
    }

    @PostMapping("/restore-post")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun restorePost(@RequestBody payload: Id) {
        postService.restore(payload.id)
    }

    @PostMapping("/clear-posts")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun clearPosts() {
        val ids = postService.clearAll()
        for (id in ids) {
            taskService.deleteIndex(id)
        }
    }

    @GetMapping("/search")
    fun search(@Validated @ModelAttribute payload: SearchRequest): PostPagination {
        val (tokens, results) = searchService.search(payload.query, payload.partial, payload.limit)

        if (results.isEmpty()) {
            return PostPagination(posts = emptyList(), cursor = -1, size = 0)
        }
        val idToScore = results.associate { it.id to it.score }
        val posts = postService.findByIds(idToScore.keys.toList()).map {
            it.copy(
                score = idToScore[it.id],
                content = it.content.highlight(tokens)
            )
        }

        return PostPagination(
            posts = posts.sortedByDescending { it.score },
            cursor = -1,
            size = results.size
        )
    }

    @GetMapping("/get-post")
    fun getPost(@Validated @RequestParam id: Int): Post {
        return postService.findWithParent(id)
    }


    @GetMapping("/get-posts")
    fun getPosts(@Validated @ModelAttribute queries: FilterPostRequest): PostPagination {
        val posts = postService.filterPosts(queries)
        return PostPagination(
            posts = posts,
            cursor = if (posts.isEmpty()) -1 else posts.last().createdAt,
            size = posts.size,
        )
    }

    @GetMapping("/get-overall-counts")
    fun getStats(): PostStats {
        return PostStats(
            postCount = postService.getCount(),
            tagCount = tagService.getCount(),
            dayCount = postService.getActiveDays()
        )
    }

    @GetMapping("/get-daily-post-counts")
    fun getDailyPostCounts(@Validated @ModelAttribute dateRange: DateRange): List<Int> {
        val (startDate, endDate, offset) = dateRange
        return postService.getDailyCounts(
            startDate = startDate.toDateTime(offset),
            endDate = endDate.toDateTime(offset, endOfDay = true)
        )
    }

    // For quick test
    @GetMapping("/upload")
    fun showFile() = """
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

    @PostMapping("/upload")
    fun uploadFile(@RequestParam("file") file: MultipartFile): FileInfo {
        return uploadService.handleFileUpload(file)
    }

    @GetMapping("/_dangerously_rebuild_all_indexes")
    fun rebuildIndexes(): Map<String, String> {
        taskService.rebuildAllIndexes()
        return mapOf("msg" to "ok")
    }
}
