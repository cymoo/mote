package site.daydream.mote.service

import site.daydream.mote.exception.BadRequestException
import site.daydream.mote.generated.Tables.POSTS
import site.daydream.mote.generated.Tables.TAGS
import site.daydream.mote.model.Post
import site.daydream.mote.model.Tag
import site.daydream.mote.model.TagWithPostCount
import site.daydream.mote.util.count
import site.daydream.mote.util.replaceFromStart
import org.jooq.DSLContext
import org.jooq.impl.DSL
import org.jooq.impl.DSL.selectOne
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Instant
import site.daydream.mote.generated.Tables.TAG_POST_ASSOC as ASSOC


@Service
@Transactional
class TagService(private val dsl: DSLContext) {
    fun findByName(name: String): Tag? =
        dsl.selectFrom(TAGS)
            .where(TAGS.NAME.eq(name))
            .fetchOneIntoClass()

    fun getCount(): Int =
        dsl.fetchCount(TAGS)

    fun getAllWithPostCount(): List<TagWithPostCount> {
        val sql = """
            SELECT t.name, t.sticky,
                (
                    SELECT COUNT(DISTINCT a.post_id)
                    FROM tag_post_assoc a
                    WHERE a.tag_id IN (
                        SELECT id
                        FROM tags
                        WHERE name = t.name
                           OR name LIKE t.name || '/%'
                    )
            ) AS post_count
            FROM tags t;
        """
        return dsl.resultQuery(sql).fetchAllIntoClass()
    }

    fun getPosts(name: String): List<Post> {
        return dsl.selectFrom(POSTS)
            .whereExists(
                selectOne()
                    .from(TAGS)
                    .join(ASSOC).on(TAGS.ID.eq(ASSOC.TAG_ID))
                    .where(ASSOC.POST_ID.eq(POSTS.ID))
                    .and(TAGS.NAME.eq(name).or(TAGS.NAME.startsWith("$name/")))
            )
            .and(POSTS.DELETED_AT.isNull)
            .fetchAllIntoClass()
    }

    fun findOrCreate(name: String): Tag {
        return findByName(name) ?: create(name)
    }

    fun insertOrUpdate(name: String, sticky: Boolean) {
        val now = Instant.now().toEpochMilli()

        dsl.insertInto(TAGS)
            .columns(TAGS.NAME, TAGS.STICKY, TAGS.CREATED_AT, TAGS.UPDATED_AT)
            .values(name, sticky, now, now)
            .onConflict(TAGS.NAME)
            .doUpdate()
            .set(TAGS.STICKY, sticky)
            .set(TAGS.UPDATED_AT, now)
            .execute()
    }

    fun create(name: String): Tag {
        val record = dsl.newRecord(TAGS, Tag(name = name))
        record.store()
        return Tag(id = record.id, name = record.name)
    }

    /**
     * Soft delete all posts under this tag and its descendant tags.
     * Performs the operation in a single transaction with minimal database access.
     */
    fun deleteAssociatedPosts(name: String) {
        val now = Instant.now().toEpochMilli()

        dsl.update(POSTS)
            .set(POSTS.DELETED_AT, now)
            .where(
                POSTS.ID.`in`(
                    dsl.select(ASSOC.POST_ID).from(ASSOC)
                        .where(
                            ASSOC.TAG_ID.`in`(
                                dsl.select(TAGS.ID).from(TAGS)
                                    .where(TAGS.NAME.eq(name).or(TAGS.NAME.startsWith("$name/")))
                            )
                        )
                )
            )
            .execute()
    }

    /**
     * Rename a tag, and if the new tag already exists, merge the tags.
     * Handles all descendant tags recursively with optimal performance.
     */
    fun renameOrMerge(name: String, newName: String) {
        if (name == newName) return
        if (newName.startsWith("$name/")) {
            throw BadRequestException("""Cannot move "$name" to a subtag of itself "$newName"""")
        }

        // Get all source-side affected tags and the direct merge target.
        val affectedTags = dsl
            .selectFrom(TAGS)
            .where(
                TAGS.NAME.eq(name)
                    .or(TAGS.NAME.eq(newName))
                    .or(TAGS.NAME.startsWith("$name/"))
            )
            .fetchAllIntoClass<Tag>()

        // Split into source tag, target tag and descendants
        val sourceTag = affectedTags.find { it.name == name }
        if (sourceTag == null && affectedTags.none { it.name.startsWith("$name/") }) {
            throw BadRequestException("tag not found")
        }
        val targetTag = affectedTags.find { it.name == newName }
        val descendants = affectedTags
            .filter { it.name != name && it.name != newName }
            .sortedByDescending { it.name.count('/') }

        descendants.forEach { descendant ->
            val newDescendantName = descendant.name.replaceFromStart(name, newName)
            val targetDescendant = findByName(newDescendantName)
            if (targetDescendant != null) {
                // Target exists - merge
                merge(descendant, targetDescendant)
            } else {
                // Target doesn't exist - rename
                rename(descendant, newDescendantName)
            }
        }

        if (sourceTag != null) {
            if (targetTag != null) {
                merge(sourceTag, targetTag)
            } else {
                rename(sourceTag, newName)
            }
        } else if (targetTag == null) {
            create(newName)
        }
    }

    /**
     * Rename a tag and update all related post content.
     * Performs the operation in a single transaction.
     */
    private fun rename(tag: Tag, newName: String) {
        val oldName = tag.name

        // Update tag name
        dsl.update(TAGS)
            .set(TAGS.NAME, newName)
            .set(TAGS.UPDATED_AT, Instant.now().toEpochMilli())
            .where(TAGS.ID.eq(tag.id))
            .execute()

        // Update post content using a single query
        dsl.update(POSTS)
            .set(
                POSTS.CONTENT,
                DSL.replace(POSTS.CONTENT, ">#$oldName<", ">#$newName<")
            )
            .where(
                POSTS.ID.`in`(
                    dsl.select(ASSOC.POST_ID)
                        .from(ASSOC)
                        .where(ASSOC.TAG_ID.eq(tag.id))
                )
            )
            .execute()
    }

    /**
     * Merge one tag into another, updating all related posts.
     * Performs the operation in a single transaction.
     */
    private fun merge(sourceTag: Tag, targetTag: Tag) {
        // Get all posts associated with the source tag
        val postIds = dsl.select(ASSOC.POST_ID)
            .from(ASSOC)
            .where(ASSOC.TAG_ID.eq(sourceTag.id))
            .fetch(ASSOC.POST_ID)

        // Update post content
        if (postIds.isNotEmpty()) {
            dsl.update(POSTS)
                .set(
                    POSTS.CONTENT,
                    DSL.replace(POSTS.CONTENT, ">#${sourceTag.name}<", ">#${targetTag.name}<")
                )
                .where(POSTS.ID.`in`(postIds))
                .execute()

            // Insert new tag associations (ignoring if they already exist)
            dsl.insertInto(ASSOC)
                .columns(ASSOC.POST_ID, ASSOC.TAG_ID)
                .select(
                    dsl.select(ASSOC.POST_ID, DSL.value(targetTag.id).`as`("tag_id"))
                        .from(ASSOC)
                        .where(ASSOC.TAG_ID.eq(sourceTag.id))
                )
                // SQLite syntax, for PostgreSQL use `onDuplicateKeyIgnore` instead
                .onConflictDoNothing()
                .execute()

            // Delete old tag associations
            dsl.deleteFrom(ASSOC)
                .where(ASSOC.TAG_ID.eq(sourceTag.id))
                .execute()
        }

        // Delete the source tag itself
        dsl.deleteFrom(TAGS)
            .where(TAGS.ID.eq(sourceTag.id))
            .execute()
    }
}
