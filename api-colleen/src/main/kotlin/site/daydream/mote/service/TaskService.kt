package site.daydream.mote.service

import io.github.cymoo.cleary.TaskScheduler
import org.slf4j.LoggerFactory
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

class TaskService(
    private val searchService: SearchService,
    private val db: DatabaseService,
) {
    private val logger = LoggerFactory.getLogger(TaskService::class.java)
    private val executor: ExecutorService = Executors.newFixedThreadPool(2)

    val scheduler = TaskScheduler {
        onTaskComplete = { event ->
            if (event.isSuccess) {
                logger.info("Task '${event.taskName}' completed in ${event.duration}ms")
            } else {
                logger.error("Task '${event.taskName}' failed", event.error)
            }
        }
    }

    init {
        scheduler.task("clear-old-posts") {
            cron("0 0 3 * * ?")
            run { clearPosts() }
        }
    }

    fun start() {
        scheduler.start()
        logger.info("Task scheduler started")
    }

    fun stop() {
        scheduler.shutdown()
        executor.shutdown()
        logger.info("Task scheduler stopped")
    }

    private fun clearPosts() {
        val thirtyDaysAgo = Instant.now().minus(30, ChronoUnit.DAYS).toEpochMilli()
        logger.info("Clearing posts deleted before: ${Instant.ofEpochMilli(thirtyDaysAgo)}")
        val deletedCount = db.executeUpdate(
            "DELETE FROM posts WHERE deleted_at < ?",
            thirtyDaysAgo
        )
        if (deletedCount > 0) {
            logger.info("Successfully deleted $deletedCount posts.")
        }
    }

    fun buildIndex(id: Int, content: String) {
        executor.submit {
            try {
                searchService.index(id, content)
            } catch (e: Exception) {
                logger.error("Failed to build index for post $id", e)
            }
        }
    }

    fun rebuildIndex(id: Int, content: String) {
        executor.submit {
            try {
                searchService.reindex(id, content)
            } catch (e: Exception) {
                logger.error("Failed to rebuild index for post $id", e)
            }
        }
    }

    fun deleteIndex(id: Int) {
        executor.submit {
            try {
                searchService.deindex(id)
            } catch (e: Exception) {
                logger.error("Failed to delete index for post $id", e)
            }
        }
    }

    fun rebuildAllIndexes() {
        executor.submit {
            try {
                searchService.clearAllIndexes()
                db.query("SELECT id, content FROM posts") { rs ->
                    rs.getInt("id") to rs.getString("content")
                }.forEach { (id, content) ->
                    searchService.index(id, content)
                }
                logger.info("All indexes rebuilt successfully")
            } catch (e: Exception) {
                logger.error("Failed to rebuild all indexes", e)
            }
        }
    }
}
