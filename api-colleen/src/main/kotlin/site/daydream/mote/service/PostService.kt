package site.daydream.mote.service

import com.fasterxml.jackson.databind.ObjectMapper
import org.slf4j.LoggerFactory
import site.daydream.mote.exception.NotFoundException
import site.daydream.mote.model.*
import site.daydream.mote.util.count
import site.daydream.mote.util.replaceFromStart
import java.sql.Connection
import java.sql.ResultSet
import java.time.Instant
import java.time.ZonedDateTime
import java.time.temporal.ChronoUnit

class PostService(
    private val db: DatabaseService,
    private val tagService: TagService,
    private val objectMapper: ObjectMapper,
) {
    private val logger = LoggerFactory.getLogger(PostService::class.java)

    fun findWithParent(id: Int): Post {
        val post = findById(id) ?: throw NotFoundException("post not found")

        post.parent = if (post.parentId != null) {
            findById(post.parentId)
        } else {
            null
        }

        return post
    }

    fun findById(id: Int?): Post? {
        if (id == null) return null

        return db.queryOne(
            "SELECT * FROM posts WHERE id = ? AND deleted_at IS NULL",
            id
        ) { it.toPost() }
    }

    fun findByShared(): List<Post> {
        return db.query(
            "SELECT * FROM posts WHERE shared = 1 AND deleted_at IS NULL ORDER BY created_at DESC"
        ) { it.toPost() }
    }

    fun findByIds(ids: List<Int>): List<Post> {
        if (ids.isEmpty()) return emptyList()

        val placeholders = ids.joinToString(",") { "?" }
        val posts = db.query(
            "SELECT * FROM posts WHERE id IN ($placeholders) AND deleted_at IS NULL",
            *ids.toTypedArray()
        ) { it.toPost() }.toMutableList()

        attachParents(posts)
        attachTags(posts)
        return posts
    }

    fun getActiveDays(): Int {
        return db.queryInt(
            "SELECT COUNT(DISTINCT date(created_at / 1000, 'unixepoch')) FROM posts WHERE deleted_at IS NULL"
        )
    }

    fun getDailyCounts(startDate: ZonedDateTime, endDate: ZonedDateTime): List<Int> {
        val offsetMs = startDate.offset.totalSeconds * 1000L
        val startTimestamp = startDate.toInstant().toEpochMilli()
        val endTimestamp = endDate.toInstant().toEpochMilli()

        val dailyCounts = db.query(
            """
            SELECT CAST((created_at + ?) / 86400000 AS INTEGER) AS local_day, COUNT(*) AS count
            FROM posts
            WHERE deleted_at IS NULL AND created_at BETWEEN ? AND ?
            GROUP BY local_day
            """,
            offsetMs, startTimestamp, endTimestamp
        ) { rs ->
            rs.getLong("local_day") to rs.getInt("count")
        }.toMap()

        val days = ChronoUnit.DAYS.between(
            startDate.toLocalDate(),
            endDate.toLocalDate()
        ).toInt() + 1

        return (0 until days).map { dayOffset ->
            val dayTimestamp = startDate
                .toLocalDate()
                .plusDays(dayOffset.toLong())
                .atStartOfDay(startDate.zone)
                .toInstant()
                .toEpochMilli()
            val localDay = (dayTimestamp + offsetMs) / 86400000L
            dailyCounts.getOrDefault(localDay, 0)
        }
    }

    fun getCount(): Int {
        return db.queryInt("SELECT COUNT(*) FROM posts WHERE deleted_at IS NULL")
    }

    fun filterPosts(options: FilterPostRequest, perPage: Int = 20): List<Post> {
        val conditions = mutableListOf<String>()
        val params = mutableListOf<Any?>()

        if (options.deleted) {
            conditions.add("p.deleted_at IS NOT NULL")
        } else {
            conditions.add("p.deleted_at IS NULL")
        }

        options.parentId?.let {
            conditions.add("p.parent_id = ?")
            params.add(it)
        }

        options.color?.let {
            conditions.add("p.color = ?")
            params.add(it.toString().lowercase())
        }

        options.tag?.let { tagName ->
            conditions.add("""
                EXISTS (
                    SELECT 1 FROM tags t
                    JOIN tag_post_assoc a ON t.id = a.tag_id
                    WHERE a.post_id = p.id AND (t.name = ? OR t.name LIKE ? || '/%')
                )
            """)
            params.add(tagName)
            params.add(tagName)
        }

        options.startDate?.let {
            conditions.add("p.created_at >= ?")
            params.add(it)
        }

        options.endDate?.let {
            conditions.add("p.created_at <= ?")
            params.add(it)
        }

        options.shared?.let {
            conditions.add("p.shared = ?")
            params.add(it)
        }

        options.hasFiles?.let {
            conditions.add(if (it) "p.files IS NOT NULL" else "p.files IS NULL")
        }

        val orderField = when (options.orderBy) {
            SortingField.CREATED_AT -> "p.created_at"
            SortingField.UPDATED_AT -> "p.updated_at"
            SortingField.DELETED_AT -> "p.deleted_at"
        }

        options.cursor?.let {
            if (options.ascending) {
                conditions.add("$orderField > ?")
            } else {
                conditions.add("$orderField < ?")
            }
            params.add(it)
        }

        val orderClause = if (options.ascending) "$orderField ASC" else "$orderField DESC"
        val whereClause = if (conditions.isNotEmpty()) conditions.joinToString(" AND ") else "1=1"

        val posts = db.query(
            "SELECT DISTINCT p.* FROM posts p WHERE $whereClause ORDER BY $orderClause LIMIT ?",
            *params.toTypedArray(), perPage
        ) { it.toPost() }.toMutableList()

        attachParents(posts)
        attachTags(posts)
        return posts
    }

    fun create(post: Post): CreateResponse {
        val now = Instant.now().toEpochMilli()
        val id = db.insertReturningId(
            """
            INSERT INTO posts (content, files, color, shared, created_at, updated_at, parent_id, children_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0)
            """,
            post.content, post.files, post.color, post.shared, now, now, post.parentId
        )

        // update post-tag association
        val hashTags = extractHashTags(post.content)
        val tags = hashTags.map { tagName -> tagService.findOrCreate(tagName) }
        updatePostTagAssoc(id, tags, true)

        // update children count
        post.parentId?.let { updateChildrenCount(it, true) }

        return CreateResponse(id = id, createdAt = now, updatedAt = now)
    }

    fun update(post: UpdatePostRequest) {
        val updatedAt = Instant.now().toEpochMilli()

        // 1. update children_count of parent
        if (post.isParentIdPresent()) {
            val oldParentId = db.queryOne(
                "SELECT parent_id FROM posts WHERE id = ?",
                post.id
            ) { rs -> rs.getObject("parent_id") as? Int }

            val newParentId = post.parentId
            when {
                oldParentId != null && newParentId == null -> updateChildrenCount(oldParentId, false)
                oldParentId == null && newParentId != null -> updateChildrenCount(newParentId, true)
            }
        }

        // 2. update post
        val setClauses = mutableListOf<String>()
        val params = mutableListOf<Any?>()

        post.content?.let {
            setClauses.add("content = ?")
            params.add(it)
        }
        post.shared?.let {
            setClauses.add("shared = ?")
            params.add(it)
        }
        if (post.isFilesPresent()) {
            setClauses.add("files = ?")
            params.add(post.files?.let { objectMapper.writeValueAsString(it) })
        }
        if (post.isColorPresent()) {
            setClauses.add("color = ?")
            params.add(post.getColor()?.toString()?.lowercase())
        }
        if (post.isParentIdPresent()) {
            setClauses.add("parent_id = ?")
            params.add(post.parentId)
        }

        setClauses.add("updated_at = ?")
        params.add(updatedAt)

        params.add(post.id)

        db.execute(
            "UPDATE posts SET ${setClauses.joinToString(", ")} WHERE id = ?",
            *params.toTypedArray()
        )

        // 3. handle tags
        post.content?.let {
            val hashTags = extractHashTags(it)
            val tags = hashTags.map { tagName -> tagService.findOrCreate(tagName) }
            updatePostTagAssoc(post.id, tags)
        }
    }

    fun delete(id: Int) {
        val parentId = db.queryOne(
            "SELECT parent_id FROM posts WHERE id = ? AND deleted_at IS NULL",
            id
        ) { rs -> rs.getObject("parent_id") as? Int }

        db.execute(
            "UPDATE posts SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
            Instant.now().toEpochMilli(), id
        )

        parentId?.let { updateChildrenCount(it, false) }
    }

    fun restore(id: Int) {
        val parentId = db.queryOne(
            "SELECT parent_id FROM posts WHERE id = ? AND deleted_at IS NOT NULL",
            id
        ) { rs -> rs.getObject("parent_id") as? Int }

        db.execute(
            "UPDATE posts SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL",
            id
        )

        parentId?.let { updateChildrenCount(it, true) }
    }

    fun clear(id: Int) {
        db.execute("DELETE FROM posts WHERE id = ? AND deleted_at IS NOT NULL", id)
    }

    fun clearAll(): List<Int> {
        val ids = db.query(
            "SELECT id FROM posts WHERE deleted_at IS NOT NULL"
        ) { it.getInt("id") }
        if (ids.isNotEmpty()) {
            db.execute("DELETE FROM posts WHERE deleted_at IS NOT NULL")
        }
        return ids
    }

    private fun updatePostTagAssoc(postId: Int, tags: List<Tag>, isNewPost: Boolean = false) {
        if (!isNewPost) {
            db.execute("DELETE FROM tag_post_assoc WHERE post_id = ?", postId)
        }
        if (tags.isEmpty()) return

        db.withConnection { conn ->
            conn.prepareStatement("INSERT OR IGNORE INTO tag_post_assoc (post_id, tag_id) VALUES (?, ?)").use { stmt ->
                tags.forEach { tag ->
                    stmt.setInt(1, postId)
                    stmt.setObject(2, tag.id)
                    stmt.addBatch()
                }
                stmt.executeBatch()
            }
        }
    }

    private fun attachTags(posts: MutableList<Post>) {
        if (posts.isEmpty()) return
        val postIds = posts.mapNotNull { it.id }
        if (postIds.isEmpty()) return

        val placeholders = postIds.joinToString(",") { "?" }
        val tagMap = db.query(
            """
            SELECT a.post_id, t.name
            FROM tag_post_assoc a
            JOIN tags t ON a.tag_id = t.id
            WHERE a.post_id IN ($placeholders)
            """,
            *postIds.toTypedArray()
        ) { rs ->
            rs.getInt("post_id") to rs.getString("name")
        }.groupBy({ it.first }, { it.second })

        posts.forEach {
            it.tags = tagMap[it.id] ?: emptyList()
        }
    }

    private fun attachParents(posts: MutableList<Post>) {
        if (posts.isEmpty()) return
        val parentIds = posts.mapNotNull { it.parentId }.distinct()

        if (parentIds.isNotEmpty()) {
            val parents = findByIds(parentIds).associateBy { it.id }
            posts.forEach {
                if (it.parentId != null) {
                    it.parent = parents[it.parentId]
                }
            }
        }
    }

    private fun updateChildrenCount(parentId: Int, increment: Boolean) {
        val op = if (increment) "children_count + 1" else "children_count - 1"
        db.execute("UPDATE posts SET children_count = $op WHERE id = ?", parentId)
    }
}

val HASH_TAG_REGEX = """<span class="hash-tag">#(.+?)</span>""".toRegex()

fun extractHashTags(content: String): Set<String> {
    return HASH_TAG_REGEX.findAll(content)
        .map { it.groupValues[1] }
        .toSet()
}

fun ResultSet.toPost(): Post {
    return Post(
        id = getInt("id"),
        content = getString("content"),
        files = getString("files"),
        color = getString("color"),
        shared = getBoolean("shared"),
        deletedAt = getObject("deleted_at") as? Long,
        createdAt = getLong("created_at"),
        updatedAt = getLong("updated_at"),
        parentId = getObject("parent_id") as? Int,
        childrenCount = getInt("children_count"),
    )
}
