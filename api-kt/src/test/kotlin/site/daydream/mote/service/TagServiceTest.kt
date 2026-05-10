package site.daydream.mote.service

import site.daydream.mote.exception.BadRequestException
import site.daydream.mote.generated.Tables.*
import site.daydream.mote.model.Post
import org.jooq.DSLContext
import org.junit.jupiter.api.*
import org.junit.jupiter.api.Assertions.*
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.test.context.ActiveProfiles
import java.time.Instant

@SpringBootTest
@ActiveProfiles("test")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class TagServiceTest(
    @Autowired private val postService: PostService,
    @Autowired private val tagService: TagService,
    @Autowired private val dsl: DSLContext
) {
    @AfterEach
    fun cleanup() {
        dsl.deleteFrom(POSTS).execute()
        dsl.deleteFrom(TAGS).execute()
        dsl.deleteFrom(TAG_POST_ASSOC).execute()
    }

    @Nested
    @DisplayName("rename or merge tag")
    inner class RenameOrMergeTag {
        @Test
        fun `test simple rename tag`() {
            // given
            val post = createPost("hello #old-name world")

            // when
            tagService.renameOrMerge("old-name", "new-name")

            // then
            assertNull(tagService.findByName("old-name"))
            assertNotNull(tagService.findByName("new-name"))
            val updatedPost = postService.findById(post.id)!!
            assertTrue(updatedPost.content.contains("#new-name"))
            assertFalse(updatedPost.content.contains("#old-name"))
        }

        @Test
        fun `test rename hierarchical tag`() {
            // given
            val post1 = createPost("hello #parent/child1 world")
            val post2 = createPost("hello #parent/child2 world")

            // when
            tagService.renameOrMerge("parent", "new-parent")

            // then
            // Check tags are renamed
            assertNull(tagService.findByName("parent"))
            assertNull(tagService.findByName("parent/child1"))
            assertNull(tagService.findByName("parent/child2"))
            assertNotNull(tagService.findByName("new-parent"))
            assertNotNull(tagService.findByName("new-parent/child1"))
            assertNotNull(tagService.findByName("new-parent/child2"))

            // Check post contents are updated
            val updatedPost1 = postService.findById(post1.id)!!
            val updatedPost2 = postService.findById(post2.id)!!
            assertTrue(updatedPost1.content.contains("#new-parent/child1"))
            assertTrue(updatedPost2.content.contains("#new-parent/child2"))
        }

        @Test
        fun `test merge tags`() {
            // given
            val post1 = createPost("hello #tag1 world")
            val post2 = createPost("hello #tag2 world")

            // when
            tagService.renameOrMerge("tag1", "tag2")

            // then
            // Check tag1 is merged into tag2
            assert(tagService.getPosts("tag1").isEmpty())
            assert(tagService.getPosts("tag2").size == 2)

            // Check post contents are updated
            val updatedPost1 = postService.findById(post1.id)!!
            val updatedPost2 = postService.findById(post2.id)!!
            assertTrue(updatedPost1.content.contains("#tag2"))
            assertTrue(updatedPost2.content.contains("#tag2"))
            assertFalse(updatedPost1.content.contains("#tag1"))
        }

        @Test
        fun `test merge hierarchical tags`() {
            // given
            val post1 = createPost("hello #team1/project world")
            val post2 = createPost("hello #team2/project world")

            // when
            tagService.renameOrMerge("team1", "team2")

            // then
            // Check team1 and its children are merged into team2
            assert(tagService.getPosts("team1").isEmpty())
            assert(tagService.getPosts("team1/project").isEmpty())
            assertNotNull(tagService.findByName("team2"))
            assertNotNull(tagService.findByName("team2/project"))

            // Check post contents are updated
            val updatedPost1 = postService.findById(post1.id)!!
            val updatedPost2 = postService.findById(post2.id)!!
            assertTrue(updatedPost1.content.contains("#team2/project"))
            assertTrue(updatedPost2.content.contains("#team2/project"))
        }

        @Test
        fun `test rename virtual parent with subtags`() {
            // given
            val post1 = createPost("hello #foo1/bar world")
            createPost("hello #foo world")

            // when
            tagService.renameOrMerge("foo1", "foo")

            // then
            assertNull(tagService.findByName("foo1"))
            assertNull(tagService.findByName("foo1/bar"))
            assertNotNull(tagService.findByName("foo"))
            assertNotNull(tagService.findByName("foo/bar"))

            val updatedPost1 = postService.findById(post1.id)!!
            assertTrue(updatedPost1.content.contains("#foo/bar"))
            assertFalse(updatedPost1.content.contains("#foo1/bar"))
        }

        @Test
        fun `test rename virtual parent creates target parent`() {
            // given
            createPost("hello #foo1/bar world")

            // when
            tagService.renameOrMerge("foo1", "foo")

            // then
            assertNotNull(tagService.findByName("foo"))
            assertNotNull(tagService.findByName("foo/bar"))
        }

        @Test
        fun `test rename to invalid hierarchical path throws exception`() {
            // given
            createPost("hello #parent world")
            createPost("hello #parent/child world")

            // when/then
            assertThrows<BadRequestException> {
                tagService.renameOrMerge("parent", "parent/child/invalid")
            }
        }

        @Test
        fun `test rename same name does nothing`() {
            // given
            val post = createPost("hello #test world")
            val originalContent = post.content

            // when
            tagService.renameOrMerge("test", "test")

            // then
            assertNotNull(tagService.findByName("test"))
            val updatedPost = postService.findById(post.id)!!
            assertEquals(originalContent, updatedPost.content)
        }

        @Test
        fun `test merge tags with multiple posts`() {
            // given
            val posts1 = listOf(
                createPost("hello #tag1 world"),
                createPost("hello #tag1 again")
            )
            val posts2 = listOf(
                createPost("hello #tag2 world"),
                createPost("hello #tag2 again")
            )

            // when
            tagService.renameOrMerge("tag1", "tag2")

            // then
            // Check all posts are updated
            posts1.forEach { post ->
                val updated = postService.findById(post.id)!!
                assertTrue(updated.content.contains("#tag2"))
                assertFalse(updated.content.contains("#tag1"))
            }
            posts2.forEach { post ->
                val updated = postService.findById(post.id)!!
                assertTrue(updated.content.contains("#tag2"))
            }
        }

        @Test
        fun `test rename tag preserves associations`() {
            // given
            val post = createPost("hello #old-name #other-tag world")
            val oldTagId = tagService.findByName("old-name")!!.id

            // when
            tagService.renameOrMerge("old-name", "new-name")

            // then
            val newTag = tagService.findByName("new-name")!!
            assertEquals(oldTagId, newTag.id) // Should preserve the ID
            val updatedPost = postService.findById(post.id)!!
            assertTrue(updatedPost.content.contains("#new-name"))
            assertTrue(updatedPost.content.contains("#other-tag"))
        }
    }

    private fun createPost(content: String): Post {
        val post = Post(
            content = replaceHashTags(content),
            createdAt = Instant.now().toEpochMilli(),
            updatedAt = Instant.now().toEpochMilli()
        )
        val response = postService.create(post)
        return postService.findById(response.id)!!
    }

    fun replaceHashTags(input: String): String {
        val regex = Regex("#[\\w-/]+")
        return regex.replace(input) { matchResult ->
            """<span class="hash-tag">${matchResult.value}</span>"""
        }
    }
}
