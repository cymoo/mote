package site.daydream.mote.service

import com.fasterxml.jackson.databind.ObjectMapper
import site.daydream.mote.exception.NotFoundException
import site.daydream.mote.generated.Tables.TAGS
import site.daydream.mote.generated.tables.Posts.POSTS
import site.daydream.mote.model.*
import org.jooq.Condition
import org.jooq.DSLContext
import org.jooq.ResultQuery
import org.jooq.impl.DSL.*
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Instant
import java.time.ZonedDateTime
import java.time.temporal.ChronoUnit
import site.daydream.mote.generated.Tables.TAG_POST_ASSOC as ASSOC

@Service
@Transactional
class PostService(
    private val tagService: TagService,
    private val dsl: DSLContext,
    private val objectMapper: ObjectMapper,
) {
    fun findWithParent(id: Int): Post {
        val rows = dsl.resultQuery(
            """
            WITH target AS (
                SELECT *
                FROM posts
                WHERE id = ? AND deleted_at IS NULL
            )
            SELECT * FROM target
            UNION ALL
            SELECT parent.*
            FROM posts AS parent
            INNER JOIN target ON parent.id = target.parent_id
            WHERE parent.deleted_at IS NULL
            """.trimIndent(),
            id
        ).fetchAllIntoClass<Post>()

        val post = rows.firstOrNull { it.id == id } ?: postNotFound()
        val parents = rows.filter { it.id != id }.associateBy { it.id }
        post.parent = post.parentId?.let { parents[it] }

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
        val posts = dsl.selectFrom(POSTS)
            .where(POSTS.ID.`in`(ids))
            .and(POSTS.DELETED_AT.isNull)
            .fetchAllIntoClass<Post>()

        return posts.toMutableList().apply {
            attachParents(this)
            attachTags(this)
        }
    }

    @Suppress("UNUSED")
    fun findChildren(parentId: Int): List<Post> {
        return dsl.selectFrom(POSTS)
            .where(POSTS.PARENT_ID.eq(parentId))
            .and(POSTS.DELETED_AT.isNull)
            .fetchAllIntoClass()
    }

    fun getActiveDays(): Int {
        return dsl.select(count(field("DISTINCT date(created_at / 1000, 'unixepoch')")))
            .from(POSTS)
            .where(POSTS.DELETED_AT.isNull)
            .fetchOne()?.value1() ?: 0
    }

    fun getDailyCounts(startDate: ZonedDateTime, endDate: ZonedDateTime): List<Int> {
        // Calculate timezone offset (in milliseconds)
        val offsetMs = startDate.offset.totalSeconds * 1000L

        // Convert to timestamp range (in milliseconds)
        val startTimestamp = startDate.toInstant().toEpochMilli()
        val endTimestamp = endDate.toInstant().toEpochMilli()

        // Count daily posts according to local time
        val dailyCounts = dsl
            .select(
                // Convert timestamp to local date
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

        // Calculate the number of days within the date range
        val days = ChronoUnit.DAYS.between(
            startDate.toLocalDate(),
            endDate.toLocalDate()
        ).toInt() + 1

        // Generate daily counts
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

    fun getCount() =
        dsl.fetchCount(POSTS, POSTS.DELETED_AT.isNull)

    fun getStatsSummary(startDate: ZonedDateTime?, endDate: ZonedDateTime?, offset: Int): StatsSummary {
        val offsetMs = (startDate?.offset?.totalSeconds?.toLong() ?: offset.toLong() * 60) * 1000L
        val startTimestamp = startDate?.toInstant()?.toEpochMilli()
        val endTimestamp = endDate?.toInstant()?.toEpochMilli()

        var condition = POSTS.DELETED_AT.isNull
        startTimestamp?.let { condition = condition.and(POSTS.CREATED_AT.greaterOrEqual(it)) }
        endTimestamp?.let { condition = condition.and(POSTS.CREATED_AT.lessThan(it)) }

        val imageCondition = POSTS.FILES.isNotNull.and(
            field("json_array_length({0})", Int::class.java, POSTS.FILES).gt(0)
        )
        val untaggedCondition = notExists(
            selectOne().from(ASSOC).where(ASSOC.POST_ID.eq(POSTS.ID))
        )

        val summary = dsl.select(
            count().`as`("total_posts"),
            countDistinct(floor((POSTS.CREATED_AT.plus(offsetMs)).div(86400000L))).`as`("active_days"),
            count().filterWhere(POSTS.SHARED.eq(true)).`as`("shared_posts"),
            count().filterWhere(imageCondition).`as`("posts_with_images"),
            count().filterWhere(untaggedCondition).`as`("untagged_posts"),
            min(POSTS.CREATED_AT).`as`("first_post_at"),
            max(POSTS.CREATED_AT).`as`("last_post_at"),
        ).from(POSTS)
            .where(condition)
            .fetchOne()

        val colorCounts = dsl.select(POSTS.COLOR.`as`("name"), count().`as`("count"))
            .from(POSTS)
            .where(condition.and(POSTS.COLOR.isNotNull))
            .groupBy(POSTS.COLOR)
            .orderBy(field("count").desc())
            .fetch { StatCount(it.get("name", String::class.java), it.get("count", Int::class.java)) }

        val topTags = dsl.resultQuery(
            """
            SELECT t.name AS name, COUNT(DISTINCT p.id) AS count
            FROM tags t
            JOIN tags child ON child.name = t.name OR child.name LIKE t.name || '/%'
            JOIN tag_post_assoc tp ON tp.tag_id = child.id
            JOIN posts p ON p.id = tp.post_id
            WHERE p.deleted_at IS NULL
              AND (? IS NULL OR p.created_at >= ?)
              AND (? IS NULL OR p.created_at < ?)
            GROUP BY t.name
            ORDER BY count DESC, t.name ASC
            LIMIT 12
            """.trimIndent(),
            startTimestamp,
            startTimestamp,
            endTimestamp,
            endTimestamp,
        ).fetch { StatCount(it.get("name", String::class.java), it.get("count", Int::class.java)) }

        return StatsSummary(
            totalPosts = summary?.get("total_posts", Int::class.java) ?: 0,
            activeDays = summary?.get("active_days", Int::class.java) ?: 0,
            sharedPosts = summary?.get("shared_posts", Int::class.java) ?: 0,
            postsWithImages = summary?.get("posts_with_images", Int::class.java) ?: 0,
            untaggedPosts = summary?.get("untagged_posts", Int::class.java) ?: 0,
            firstPostAt = summary?.get("first_post_at", Long::class.java),
            lastPostAt = summary?.get("last_post_at", Long::class.java),
            colorCounts = colorCounts,
            topTags = topTags,
        )
    }

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
                val imageCondition = POSTS.FILES.isNotNull.and(
                    field("json_array_length({0})", Int::class.java, POSTS.FILES).gt(0)
                )
                condition = if (it) {
                    condition.and(imageCondition)
                } else {
                    condition.and(POSTS.FILES.isNull.or(imageCondition.not()))
                }
            }

            untagged?.let {
                val tagExists = exists(
                    selectOne().from(ASSOC).where(ASSOC.POST_ID.eq(POSTS.ID))
                )
                condition = condition.and(if (it) tagExists.not() else tagExists)
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

        // 1. update `children_count` of parent
        post.parentId.ifPresent { parentId ->
            val record = dsl.select(POSTS.PARENT_ID)
                .from(POSTS)
                .where(POSTS.ID.eq(post.id))
                .fetchOne() ?: postNotFound()

            val oldParentId = record.get(POSTS.PARENT_ID)

            when {
                oldParentId != null && parentId == null -> {
                    updateChildrenCount(oldParentId, false)
                }

                oldParentId == null && parentId != null -> {
                    updateChildrenCount(parentId, true)
                }
            }
        }

        // 2. update post
        dsl.update(POSTS)
            .apply {
                post.content?.let { this.set(POSTS.CONTENT, it) }
                post.shared?.let { this.set(POSTS.SHARED, it) }
                post.files.ifPresent {
                    this.set(
                        POSTS.FILES,
                        it?.let { files -> objectMapper.writeValueAsString(files) })
                }
                post.color.ifPresent { this.set(POSTS.COLOR, it?.toString()?.lowercase()) }
                post.parentId.ifPresent { this.set(POSTS.PARENT_ID, it) }
            }
            .set(POSTS.UPDATED_AT, updatedAt)
            .where(POSTS.ID.eq(post.id))
            .execute()

        // 3. handle tags
        post.content?.let {
            val hashTags = extractHashTags(it)
            val tags = hashTags.map { tagName -> tagService.findOrCreate(tagName) }
            // update post-tag association
            updatePostTagAssoc(post.id, tags)
        }
    }

    fun delete(id: Int) {
        val post = dsl.update(POSTS)
            .set(POSTS.DELETED_AT, Instant.now().toEpochMilli())
            .where(POSTS.ID.eq(id))
            .and(POSTS.DELETED_AT.isNull)
            .returning(POSTS.PARENT_ID)
            .fetchOne() ?: postNotFound()

        post.parentId?.let {
            updateChildrenCount(it, false)
        }
    }

    fun restore(id: Int) {
        val post = dsl.update(POSTS)
            .set(POSTS.DELETED_AT, null as Long?)
            .where(POSTS.ID.eq(id))
            .and(POSTS.DELETED_AT.isNotNull)
            .returning(POSTS.PARENT_ID)
            .fetchOne() ?: postNotFound()

        post.parentId?.let {
            updateChildrenCount(it, true)
        }
    }

    fun clear(id: Int) {
        dsl.deleteFrom(POSTS)
            .where(POSTS.ID.eq(id))
            .and(POSTS.DELETED_AT.isNotNull).execute()
    }

    fun clearAll(): List<Int> {
        return dsl.deleteFrom(POSTS).where(POSTS.DELETED_AT.isNotNull)
            .returning(POSTS.ID)
            .fetch(POSTS.ID)
    }

    private fun updatePostTagAssoc(postId: Int, tags: List<Tag>, isNewPost: Boolean = false) {
        // Remove old relationships
        if (!isNewPost) {
            dsl.deleteFrom(ASSOC)
                .where(ASSOC.POST_ID.eq(postId))
                .execute()
        }

        if (tags.isEmpty()) return

        // Insert new relationships
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
        val postIds = posts.map { it.id }

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
            val parentList = dsl.selectFrom(POSTS)
                .where(POSTS.ID.`in`(parentIds))
                .and(POSTS.DELETED_AT.isNull)
                .fetchAllIntoClass<Post>()
                .toMutableList()

            attachTags(parentList)

            val parents = parentList.associateBy { it.id }
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

fun postNotFound(): Nothing = throw NotFoundException("post not found")

inline fun <reified T : Any> ResultQuery<*>.fetchAllIntoClass(): List<T> {
    return this.fetchInto(T::class.java)
}

inline fun <reified T : Any> ResultQuery<*>.fetchOneIntoClass(): T? {
    return this.fetchOneInto(T::class.java)
}
