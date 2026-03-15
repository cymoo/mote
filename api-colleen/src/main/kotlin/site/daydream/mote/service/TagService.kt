package site.daydream.mote.service

import org.jooq.DSLContext
import org.jooq.impl.DSL
import org.jooq.impl.DSL.selectOne
import org.slf4j.LoggerFactory
import site.daydream.mote.exception.BadRequestException
import site.daydream.mote.generated.Tables.POSTS
import site.daydream.mote.generated.Tables.TAGS
import site.daydream.mote.model.Post
import site.daydream.mote.model.Tag
import site.daydream.mote.model.TagWithPostCount
import site.daydream.mote.util.count
import site.daydream.mote.util.replaceFromStart
import java.time.Instant
import site.daydream.mote.generated.Tables.TAG_POST_ASSOC as ASSOC

class TagService(private val dsl: DSLContext) {
    private val logger = LoggerFactory.getLogger(TagService::class.java)

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

    fun renameOrMerge(name: String, newName: String) {
        if (name == newName) return
        if (newName.startsWith(name) && newName.count('/') > name.count('/')) {
            throw BadRequestException("""Cannot move "$name" to a subtag of itself "$newName"""")
        }

        // Get all affected tags in a single query
        val affectedTags = dsl
            .selectFrom(TAGS)
            .where(
                TAGS.NAME.eq(name)
                    .or(TAGS.NAME.eq(newName))
                    .or(TAGS.NAME.startsWith("$name/"))
            )
            .fetchAllIntoClass<Tag>()

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

        dsl.update(TAGS)
            .set(TAGS.NAME, newName)
            .set(TAGS.UPDATED_AT, Instant.now().toEpochMilli())
            .where(TAGS.ID.eq(tag.id))
            .execute()

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

    private fun merge(sourceTag: Tag, targetTag: Tag) {
        val postIds = dsl.select(ASSOC.POST_ID)
            .from(ASSOC)
            .where(ASSOC.TAG_ID.eq(sourceTag.id))
            .fetch(ASSOC.POST_ID)

        if (postIds.isEmpty()) return

        // Update post content
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
            .onConflictDoNothing()
            .execute()

        // Delete old associations and source tag
        dsl.deleteFrom(ASSOC)
            .where(ASSOC.TAG_ID.eq(sourceTag.id))
            .execute()

        dsl.deleteFrom(TAGS)
            .where(TAGS.ID.eq(sourceTag.id))
            .execute()
    }
}
