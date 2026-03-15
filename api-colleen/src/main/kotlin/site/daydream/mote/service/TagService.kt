package site.daydream.mote.service

import org.slf4j.LoggerFactory
import site.daydream.mote.exception.BadRequestException
import site.daydream.mote.model.Post
import site.daydream.mote.model.Tag
import site.daydream.mote.model.TagWithPostCount
import site.daydream.mote.util.count
import site.daydream.mote.util.replaceFromStart
import java.time.Instant

class TagService(private val db: DatabaseService) {
    private val logger = LoggerFactory.getLogger(TagService::class.java)

    fun findByName(name: String): Tag? {
        return db.queryOne(
            "SELECT * FROM tags WHERE name = ?",
            name
        ) { it.toTag() }
    }

    fun getCount(): Int {
        return db.queryInt("SELECT COUNT(*) FROM tags")
    }

    fun getAllWithPostCount(): List<TagWithPostCount> {
        return db.query(
            """
            SELECT t.name, t.sticky,
                (
                    SELECT COUNT(DISTINCT a.post_id)
                    FROM tag_post_assoc a
                    WHERE a.tag_id IN (
                        SELECT id FROM tags WHERE name = t.name OR name LIKE t.name || '/%'
                    )
                ) AS post_count
            FROM tags t
            """
        ) { rs ->
            TagWithPostCount(
                name = rs.getString("name"),
                sticky = rs.getBoolean("sticky"),
                postCount = rs.getLong("post_count")
            )
        }
    }

    fun findOrCreate(name: String): Tag {
        return findByName(name) ?: create(name)
    }

    fun insertOrUpdate(name: String, sticky: Boolean) {
        val now = Instant.now().toEpochMilli()
        db.execute(
            """
            INSERT INTO tags (name, sticky, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET sticky = ?, updated_at = ?
            """,
            name, sticky, now, now, sticky, now
        )
    }

    fun create(name: String): Tag {
        val now = Instant.now().toEpochMilli()
        val id = db.insertReturningId(
            "INSERT INTO tags (name, sticky, created_at, updated_at) VALUES (?, ?, ?, ?)",
            name, false, now, now
        )
        return Tag(id = id, name = name, createdAt = now, updatedAt = now)
    }

    fun deleteAssociatedPosts(name: String) {
        val now = Instant.now().toEpochMilli()
        db.execute(
            """
            UPDATE posts SET deleted_at = ?
            WHERE id IN (
                SELECT a.post_id FROM tag_post_assoc a
                WHERE a.tag_id IN (
                    SELECT id FROM tags WHERE name = ? OR name LIKE ? || '/%'
                )
            )
            """,
            now, name, name
        )
    }

    fun renameOrMerge(name: String, newName: String) {
        if (name == newName) return
        if (newName.startsWith(name) && newName.count('/') > name.count('/')) {
            throw BadRequestException("""Cannot move "$name" to a subtag of itself "$newName"""")
        }

        // Get all affected tags
        val affectedTags = db.query(
            "SELECT * FROM tags WHERE name = ? OR name = ? OR name LIKE ? || '/%'",
            name, newName, name
        ) { it.toTag() }

        val sourceTag = affectedTags.find { it.name == name } ?: create(name)
        val targetTag = affectedTags.find { it.name == newName }
        val descendants = affectedTags
            .filter { it.name != name && it.name != newName }
            .sortedByDescending { it.name.count('/') }

        descendants.forEach { descendant ->
            val newDescendantName = descendant.name.replaceFromStart(name, newName)
            val targetDescendant = findByName(newDescendantName)
            if (targetDescendant != null) {
                merge(descendant, targetDescendant)
            } else {
                rename(descendant, newDescendantName)
            }
        }

        if (targetTag != null) {
            merge(sourceTag, targetTag)
        } else {
            rename(sourceTag, newName)
        }
    }

    private fun rename(tag: Tag, newName: String) {
        val oldName = tag.name

        db.execute(
            "UPDATE tags SET name = ?, updated_at = ? WHERE id = ?",
            newName, Instant.now().toEpochMilli(), tag.id
        )

        db.execute(
            """
            UPDATE posts SET content = REPLACE(content, ?||'<', ?||'<')
            WHERE id IN (
                SELECT post_id FROM tag_post_assoc WHERE tag_id = ?
            )
            """,
            ">#$oldName", ">#$newName", tag.id
        )
    }

    private fun merge(sourceTag: Tag, targetTag: Tag) {
        val postIds = db.query(
            "SELECT post_id FROM tag_post_assoc WHERE tag_id = ?",
            sourceTag.id
        ) { it.getInt("post_id") }

        if (postIds.isEmpty()) return

        val placeholders = postIds.joinToString(",") { "?" }

        // Update post content
        db.execute(
            "UPDATE posts SET content = REPLACE(content, ?, ?) WHERE id IN ($placeholders)",
            ">#${sourceTag.name}<", ">#${targetTag.name}<", *postIds.toTypedArray()
        )

        // Insert new tag associations
        db.withConnection { conn ->
            conn.prepareStatement(
                """
                INSERT OR IGNORE INTO tag_post_assoc (post_id, tag_id)
                SELECT post_id, ? FROM tag_post_assoc WHERE tag_id = ?
                """
            ).use { stmt ->
                stmt.setObject(1, targetTag.id)
                stmt.setObject(2, sourceTag.id)
                stmt.executeUpdate()
            }
        }

        // Delete old associations and source tag
        db.execute("DELETE FROM tag_post_assoc WHERE tag_id = ?", sourceTag.id)
        db.execute("DELETE FROM tags WHERE id = ?", sourceTag.id)
    }
}

fun java.sql.ResultSet.toTag(): Tag {
    return Tag(
        id = getInt("id"),
        name = getString("name"),
        sticky = getBoolean("sticky"),
        createdAt = getLong("created_at"),
        updatedAt = getLong("updated_at"),
    )
}
