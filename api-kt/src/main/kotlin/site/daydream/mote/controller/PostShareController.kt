package site.daydream.mote.controller

import com.fasterxml.jackson.databind.ObjectMapper
import site.daydream.mote.config.AppConfig
import site.daydream.mote.model.FileInfo
import site.daydream.mote.service.PostService
import org.springframework.stereotype.Controller
import org.springframework.ui.Model
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.RequestMapping

@Controller
@RequestMapping("/shared")
class PostShareController(
    private val appConfig: AppConfig,
    private val postService: PostService,
    private val objectMapper: ObjectMapper,
) {
    @GetMapping
    fun index(model: Model): String {
        val posts = postService.findByShared().map { post ->
            val (title, description) = extractHeaderAndDescriptionFromHtml(post.content)
            mutableMapOf(
                "id" to post.id,
                "title" to (title ?: "None"),
                "description" to description,
                "createdAt" to post.createdAt
            )
        }

        model.addAttribute("posts", posts)
        model.addAttribute("aboutUrl", appConfig.aboutUrl)
        return "post-list.html"
    }

    @GetMapping("/{id}")
    fun getPost(model: Model, @PathVariable id: Int): String {
        val post = postService.findById(id) ?: return "404.html"
        if (!post.shared) return "404.html"

        val (title, _) = extractHeaderAndDescriptionFromHtml(post.content)

        val images = post.files?.let { objectMapper.readValue(it, Array<FileInfo>::class.java) } ?: emptyArray()
        model.addAttribute("post", post)
        model.addAttribute("title", title)
        model.addAttribute("images", images)
        model.addAttribute("aboutUrl", appConfig.aboutUrl)
        return "post-item.html"
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
