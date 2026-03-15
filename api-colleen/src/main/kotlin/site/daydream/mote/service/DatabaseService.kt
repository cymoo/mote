package site.daydream.mote.service

import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import org.flywaydb.core.Flyway
import org.jooq.DSLContext
import org.jooq.SQLDialect
import org.jooq.impl.DSL
import org.slf4j.LoggerFactory
import site.daydream.mote.config.DatabaseConfig

class DatabaseService(private val config: DatabaseConfig) {
    private val logger = LoggerFactory.getLogger(DatabaseService::class.java)
    private val dataSource: HikariDataSource

    val dsl: DSLContext

    init {
        val hikariConfig = HikariConfig().apply {
            jdbcUrl = config.jdbcUrl
            driverClassName = "org.sqlite.JDBC"
            maximumPoolSize = config.poolSize
            minimumIdle = maxOf(2, config.poolSize / 5)
            idleTimeout = 30_000
            maxLifetime = 1_800_000
            connectionTimeout = 30_000
            poolName = "SQLite-Pool"
        }
        dataSource = HikariDataSource(hikariConfig)

        dsl = DSL.using(dataSource, SQLDialect.SQLITE)

        configureSQLite()

        if (config.autoMigrate) {
            migrate()
        }
    }

    private fun configureSQLite() {
        dsl.execute("PRAGMA journal_mode = WAL")
        dsl.execute("PRAGMA foreign_keys = ON")

        val journalMode = dsl.fetchValue("PRAGMA journal_mode") as String
        val foreignKeys = dsl.fetchValue("PRAGMA foreign_keys") as Int

        logger.info("SQLite journal mode: $journalMode")
        logger.info("SQLite foreign keys: $foreignKeys")
    }

    fun migrate() {
        logger.info("Running database migrations...")
        val flyway = Flyway.configure()
            .dataSource(dataSource)
            .locations("classpath:db/migration")
            .baselineOnMigrate(true)
            .validateOnMigrate(true)
            .load()
        flyway.migrate()
        logger.info("Database migrations completed")
    }

    fun getMigrationInfo(): List<Map<String, Any?>> {
        val flyway = Flyway.configure()
            .dataSource(dataSource)
            .locations("classpath:db/migration")
            .baselineOnMigrate(true)
            .load()
        return flyway.info().all().map { info ->
            mapOf(
                "version" to info.version?.toString(),
                "description" to info.description,
                "type" to info.type.toString(),
                "installedOn" to info.installedOn?.toString(),
                "state" to info.state.toString()
            )
        }
    }

    fun repairMigration() {
        val flyway = Flyway.configure()
            .dataSource(dataSource)
            .locations("classpath:db/migration")
            .baselineOnMigrate(true)
            .load()
        flyway.repair()
    }

    fun close() {
        dataSource.close()
    }
}
