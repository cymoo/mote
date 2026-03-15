package site.daydream.mote.controller

import com.fasterxml.jackson.databind.ObjectMapper
import io.github.cymoo.colleen.*
import site.daydream.mote.config.AppConfig
import site.daydream.mote.middleware.render
import site.daydream.mote.model.FileInfo
import site.daydream.mote.service.PostService

/**
 * Controller for rendering shared post pages using Pebble templates.
 */
@Controller("/shared")
class PostPageController {

    @Get
    fun index(ctx: Context, postService: PostService, appConfig: AppConfig) {
        val posts = postService.findByShared().map { post ->
            val (title, description) = extractHeaderAndDescriptionFromHtml(post.content)
            mutableMapOf<String, Any?>(
                "id" to post.id,
                "title" to (title ?: "None"),
                "description" to description,
                "createdAt" to post.createdAt
            )
        }

        ctx.render("post-list.html", mapOf("posts" to posts, "aboutUrl" to appConfig.aboutUrl))
    }

    @Get("/{id}")
    fun getPost(id: Path<Int>, ctx: Context, postService: PostService, appConfig: AppConfig) {
        val post = postService.findById(id.value)
        if (post == null || !post.shared) {
            ctx.render("404.html", emptyMap<String, Any>())
            ctx.status(404)
            return
        }

        val (title, _) = extractHeaderAndDescriptionFromHtml(post.content)
        val objectMapper = ctx.getService<ObjectMapper>()
        val images = post.files?.let { objectMapper.readValue(it, Array<FileInfo>::class.java) } ?: emptyArray()

        ctx.render(
            "post-item.html",
            mapOf(
                "post" to post,
                "title" to title,
                "images" to images.toList(),
                "aboutUrl" to appConfig.aboutUrl
            )
        )
    }
}

private val headerBoldParagraphPattern =
    "<h[1-3][^>]*>(.*?)</h[1-3]>\\s*(?:<p[^>]*><strong>(.*?)</strong></p>)?".toRegex()
private val strongTagPattern = "</?strong>".toRegex()

fun extractHeaderAndDescriptionFromHtml(html: String): Pair<String?, String?> {
    val match = headerBoldParagraphPattern.find(html)
    return if (match != null) {
        val title = match.groupValues[1]
        val boldParagraph = match.groupValues[2].takeIf { it.isNotEmpty() }?.let {
            strongTagPattern.replace(it, "")
        }
        Pair(title, boldParagraph)
    } else {
        Pair(null, null)
    }
}
