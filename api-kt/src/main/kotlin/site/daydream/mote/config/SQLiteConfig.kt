package site.daydream.mote.config

import jakarta.annotation.PostConstruct
import site.daydream.mote.logger
import org.jooq.DSLContext
import org.springframework.context.annotation.Configuration
import org.springframework.transaction.annotation.Transactional

@Configuration
class SQLiteConfig(
    private val dsl: DSLContext
) {

    @PostConstruct
    @Transactional
    fun configureSQLite() {
        dsl.execute("PRAGMA journal_mode = WAL")
        dsl.execute("PRAGMA foreign_keys = ON")

        val journalMode = dsl.fetchValue("PRAGMA journal_mode") as String
        val foreignKeys = dsl.fetchValue("PRAGMA foreign_keys") as Int

        logger.info("SQLite journal Mode: $journalMode")
        logger.info("SQLite Foreign Keys: $foreignKeys")
    }
}
