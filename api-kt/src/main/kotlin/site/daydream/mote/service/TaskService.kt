package site.daydream.mote.service

import site.daydream.mote.generated.Tables.POSTS
import site.daydream.mote.logger
import org.jooq.DSLContext
import org.springframework.scheduling.annotation.Async
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Service
import java.time.Instant
import java.time.temporal.ChronoUnit

@Service
class TaskService(
    private val searchService: SearchService,
    private val dsl: DSLContext,
    private val driveService: DriveService,
    private val driveUploadService: DriveUploadService,
    private val driveShareService: DriveShareService,
) {

    @Scheduled(cron = "0 0 3 * * ?")
    fun clearPosts() {
        val thirtyDaysAgo = Instant.now().minus(30, ChronoUnit.DAYS).toEpochMilli()
        logger.info("Clearing posts deleted before: ${Instant.ofEpochMilli(thirtyDaysAgo)}")
        val deletedCount = dsl.deleteFrom(POSTS)
            .where(POSTS.DELETED_AT.lessThan(thirtyDaysAgo))
            .execute()
        if (deletedCount > 0) {
            logger.info("Successfully deleted $deletedCount posts.")
        }
    }

    @Scheduled(cron = "0 0 * * * ?")
    fun purgeExpiredDriveUploads() {
        val n = driveUploadService.purgeExpired()
        if (n > 0) {
            logger.info("Purged $n expired drive uploads.")
        }
    }

    @Scheduled(cron = "0 0 * * * ?")
    fun purgeExpiredDriveShares() {
        val n = driveShareService.purgeExpired()
        if (n > 0) {
            logger.info("Purged $n expired drive shares.")
        }
    }

    /** Hard-deletes drive nodes trashed more than 30 days ago; blob removal is refcounted. */
    @Scheduled(cron = "0 30 2 * * ?")
    fun purgeOldDriveTrash() {
        val cutoff = Instant.now().minus(30, ChronoUnit.DAYS).toEpochMilli()
        val n = driveService.purgeTrashOlderThan(cutoff)
        if (n > 0) {
            logger.info("Purged $n drive nodes from trash.")
        }
    }

    @Async
    fun buildIndex(id: Int, content: String) {
        searchService.index(id, content)
    }

    @Async
    fun rebuildIndex(id: Int, content: String) {
        searchService.reindex(id, content)
    }

    @Async
    fun deleteIndex(id: Int) {
        searchService.deindex(id)
    }

    @Async
    fun rebuildAllIndexes() {
        searchService.clearAllIndexes()
        dsl.select(POSTS.ID, POSTS.CONTENT).from(POSTS).fetch().forEach {
            searchService.index(it.value1(), it.value2())
        }
    }
}
