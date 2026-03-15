package site.daydream.mote.service

import com.fasterxml.jackson.databind.ObjectMapper
import org.jooq.Condition
import org.jooq.DSLContext
import org.jooq.ResultQuery
import org.jooq.impl.DSL.*
import org.slf4j.LoggerFactory
import site.daydream.mote.exception.NotFoundException
import site.daydream.mote.generated.Tables.TAGS
import site.daydream.mote.generated.tables.Posts.POSTS
import site.daydream.mote.model.*
import site.daydream.mote.util.count
import site.daydream.mote.util.replaceFromStart
import java.time.Instant
import java.time.ZonedDateTime
import java.time.temporal.ChronoUnit
import site.daydream.mote.generated.Tables.TAG_POST_ASSOC as ASSOC

class PostService(
    private val dsl: DSLContext,
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

        return dsl.selectFrom(POSTS)
            .where(POSTS.ID.eq(id))
            .and(POSTS.DELETED_AT.isNull)
            .fetchOneIntoClass()
    }

    fun findByShared(): List<Post> {
        return dsl.selectFrom(POSTS)
            .where(POSTS.SHARED.eq(true))
            .and(POSTS.DELETED_AT.isNull)
            .orderBy(POSTS.CREATED_AT.desc())
            .fetchAllIntoClass()
    }

    fun findByIds(ids: List<Int>): List<Post> {
        if (ids.isEmpty()) return emptyList()

        val posts = dsl.selectFrom(POSTS)
            .where(POSTS.ID.`in`(ids))
            .and(POSTS.DELETED_AT.isNull)
            .fetchAllIntoClass<Post>()

        return posts.toMutableList().apply {
            attachParents(this)
            attachTags(this)
        }
    }

    fun getActiveDays(): Int {
        return dsl.select(count(field("DISTINCT date(created_at / 1000, 'unixepoch')")))
            .from(POSTS)
            .where(POSTS.DELETED_AT.isNull)
            .fetchOne()?.value1() ?: 0
    }

    fun getDailyCounts(startDate: ZonedDateTime, endDate: ZonedDateTime): List<Int> {
        val offsetMs = startDate.offset.totalSeconds * 1000L
        val startTimestamp = startDate.toInstant().toEpochMilli()
        val endTimestamp = endDate.toInstant().toEpochMilli()

        val dailyCounts = dsl
            .select(
                floor((POSTS.CREATED_AT.plus(offsetMs)).div(86400000L)).`as`("local_day"),
                count().`as`("count")
            )
            .from(POSTS)
            .where(POSTS.DELETED_AT.isNull)
            .and(POSTS.CREATED_AT.between(startTimestamp).and(endTimestamp))
            .groupBy(field("local_day"))
            .fetchMap(
                { it.get("local_day", Long::class.java) },
                { it.get("count", Int::class.java) }
            )

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

    fun getCount(): Int =
        dsl.fetchCount(POSTS, POSTS.DELETED_AT.isNull)

    fun filterPosts(options: FilterPostRequest, perPage: Int = 20): List<Post> {
        var condition: Condition = trueCondition()

        with(options) {
            condition = if (deleted) {
                condition.and(POSTS.DELETED_AT.isNotNull)
            } else {
                condition.and(POSTS.DELETED_AT.isNull)
            }

            parentId?.let {
                condition = condition.and(POSTS.PARENT_ID.eq(it))
            }

            color?.let {
                condition = condition.and(POSTS.COLOR.eq(it.toString().lowercase()))
            }

            tag?.let {
                condition = condition.and(
                    exists(
                        selectOne()
                            .from(TAGS)
                            .join(ASSOC).on(TAGS.ID.eq(ASSOC.TAG_ID))
                            .where(ASSOC.POST_ID.eq(POSTS.ID))
                            .and(TAGS.NAME.eq(it).or(TAGS.NAME.startsWith("$it/")))
                    )
                )
            }

            startDate?.let {
                condition = condition.and(POSTS.CREATED_AT.greaterOrEqual(startDate))
            }

            endDate?.let {
                condition = condition.and(POSTS.CREATED_AT.lessOrEqual(endDate))
            }

            shared?.let {
                condition = condition.and(POSTS.SHARED.eq(it))
            }

            hasFiles?.let {
                condition = if (it) {
                    condition.and(POSTS.FILES.isNotNull)
                } else {
                    condition.and(POSTS.FILES.isNull)
                }
            }

            val orderField = when (orderBy) {
                SortingField.CREATED_AT -> POSTS.CREATED_AT
                SortingField.UPDATED_AT -> POSTS.UPDATED_AT
                SortingField.DELETED_AT -> POSTS.DELETED_AT
            }

            cursor?.let {
                condition = if (ascending) {
                    condition.and(orderField.greaterThan(it))
                } else {
                    condition.and(orderField.lessThan(it))
                }
            }

            val orderClause = if (ascending) orderField.asc() else orderField.desc()

            return dsl
                .selectDistinct()
                .from(POSTS)
                .where(condition)
                .orderBy(orderClause)
                .limit(perPage)
                .fetchInto(Post::class.java)
                .toMutableList().apply {
                    attachParents(this)
                    attachTags(this)
                }
        }
    }

    fun create(post: Post): CreateResponse {
        val record = dsl.newRecord(POSTS, post)
        record.store()

        // update post-tag association
        val hashTags = extractHashTags(post.content)
        val tags = hashTags.map { tagName -> tagService.findOrCreate(tagName) }
        updatePostTagAssoc(record.id, tags, true)

        // update children count
        post.parentId?.let { updateChildrenCount(it, true) }

        return CreateResponse(
            id = record.id,
            createdAt = record.createdAt,
            updatedAt = record.updatedAt,
        )
    }

    fun update(post: UpdatePostRequest) {
        val updatedAt = Instant.now().toEpochMilli()

        // 1. update children_count of parent
        if (post.isParentIdPresent()) {
            val oldParentId = dsl.select(POSTS.PARENT_ID)
                .from(POSTS)
                .where(POSTS.ID.eq(post.id))
                .fetchOne()?.get(POSTS.PARENT_ID)

            val newParentId = post.parentId
            when {
                oldParentId != null && newParentId == null -> updateChildrenCount(oldParentId, false)
                oldParentId == null && newParentId != null -> updateChildrenCount(newParentId, true)
            }
        }

        // 2. update post
        dsl.update(POSTS)
            .apply {
                post.content?.let { this.set(POSTS.CONTENT, it) }
                post.shared?.let { this.set(POSTS.SHARED, it) }
                if (post.isFilesPresent()) {
                    this.set(
                        POSTS.FILES,
                        post.files?.let { objectMapper.writeValueAsString(it) })
                }
                if (post.isColorPresent()) {
                    this.set(POSTS.COLOR, post.getColor()?.toString()?.lowercase())
                }
                if (post.isParentIdPresent()) {
                    this.set(POSTS.PARENT_ID, post.parentId)
                }
            }
            .set(POSTS.UPDATED_AT, updatedAt)
            .where(POSTS.ID.eq(post.id))
            .execute()

        // 3. handle tags
        post.content?.let {
            val hashTags = extractHashTags(it)
            val tags = hashTags.map { tagName -> tagService.findOrCreate(tagName) }
            updatePostTagAssoc(post.id, tags)
        }
    }

    fun delete(id: Int) {
        val parentId = dsl.select(POSTS.PARENT_ID)
            .from(POSTS)
            .where(POSTS.ID.eq(id))
            .and(POSTS.DELETED_AT.isNull)
            .fetchOne()?.get(POSTS.PARENT_ID)

        dsl.update(POSTS)
            .set(POSTS.DELETED_AT, Instant.now().toEpochMilli())
            .where(POSTS.ID.eq(id))
            .and(POSTS.DELETED_AT.isNull)
            .execute()

        parentId?.let { updateChildrenCount(it, false) }
    }

    fun restore(id: Int) {
        val parentId = dsl.select(POSTS.PARENT_ID)
            .from(POSTS)
            .where(POSTS.ID.eq(id))
            .and(POSTS.DELETED_AT.isNotNull)
            .fetchOne()?.get(POSTS.PARENT_ID)

        dsl.update(POSTS)
            .set(POSTS.DELETED_AT, null as Long?)
            .where(POSTS.ID.eq(id))
            .and(POSTS.DELETED_AT.isNotNull)
            .execute()

        parentId?.let { updateChildrenCount(it, true) }
    }

    fun clear(id: Int) {
        dsl.deleteFrom(POSTS)
            .where(POSTS.ID.eq(id))
            .and(POSTS.DELETED_AT.isNotNull)
            .execute()
    }

    fun clearAll(): List<Int> {
        return dsl.deleteFrom(POSTS)
            .where(POSTS.DELETED_AT.isNotNull)
            .returning(POSTS.ID)
            .fetch(POSTS.ID)
    }

    private fun updatePostTagAssoc(postId: Int, tags: List<Tag>, isNewPost: Boolean = false) {
        if (!isNewPost) {
            dsl.deleteFrom(ASSOC)
                .where(ASSOC.POST_ID.eq(postId))
                .execute()
        }

        if (tags.isEmpty()) return

        dsl.batch(
            tags.map { tag ->
                dsl.insertInto(ASSOC)
                    .columns(ASSOC.POST_ID, ASSOC.TAG_ID)
                    .values(postId, tag.id)
            }
        ).execute()
    }

    private fun attachTags(posts: MutableList<Post>) {
        if (posts.isEmpty()) return
        val postIds = posts.mapNotNull { it.id }
        if (postIds.isEmpty()) return

        val tags = dsl.select(ASSOC.POST_ID, TAGS.NAME)
            .from(ASSOC)
            .join(TAGS).on(ASSOC.TAG_ID.eq(TAGS.ID))
            .where(ASSOC.POST_ID.`in`(postIds))
            .fetchGroups(
                { it.get(0, Int::class.java) },
                { it.get(1, String::class.java) }
            )

        posts.forEach {
            it.tags = tags[it.id] ?: emptyList()
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
        dsl.update(POSTS)
            .set(
                POSTS.CHILDREN_COUNT,
                if (increment) POSTS.CHILDREN_COUNT.plus(1)
                else POSTS.CHILDREN_COUNT.minus(1)
            )
            .where(POSTS.ID.eq(parentId))
            .execute()
    }
}

val HASH_TAG_REGEX = """<span class="hash-tag">#(.+?)</span>""".toRegex()

fun extractHashTags(content: String): Set<String> {
    return HASH_TAG_REGEX.findAll(content)
        .map { it.groupValues[1] }
        .toSet()
}

inline fun <reified T : Any> ResultQuery<*>.fetchAllIntoClass(): List<T> {
    return this.fetchInto(T::class.java)
}

inline fun <reified T : Any> ResultQuery<*>.fetchOneIntoClass(): T? {
    return this.fetchOneInto(T::class.java)
}
