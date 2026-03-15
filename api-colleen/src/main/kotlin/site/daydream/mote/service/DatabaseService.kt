package site.daydream.mote.service

import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import org.flywaydb.core.Flyway
import org.slf4j.LoggerFactory
import site.daydream.mote.config.DatabaseConfig
import java.sql.Connection
import java.sql.ResultSet

class DatabaseService(private val config: DatabaseConfig) {
    private val logger = LoggerFactory.getLogger(DatabaseService::class.java)
    private val dataSource: HikariDataSource

    init {
        val hikariConfig = HikariConfig().apply {
            jdbcUrl = config.jdbcUrl
            driverClassName = "org.sqlite.JDBC"
            maximumPoolSize = config.poolSize
            minimumIdle = 2
        }
        dataSource = HikariDataSource(hikariConfig)

        configureSQLite()

        if (config.autoMigrate) {
            migrate()
        }
    }

    private fun configureSQLite() {
        dataSource.connection.use { conn ->
            conn.createStatement().use { stmt ->
                stmt.execute("PRAGMA journal_mode=WAL")
                stmt.execute("PRAGMA foreign_keys=ON")
            }
        }
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

    fun getConnection(): Connection = dataSource.connection

    fun <T> withConnection(block: (Connection) -> T): T {
        return dataSource.connection.use(block)
    }

    fun <T> withTransaction(block: (Connection) -> T): T {
        return dataSource.connection.use { conn ->
            conn.autoCommit = false
            try {
                val result = block(conn)
                conn.commit()
                result
            } catch (e: Exception) {
                conn.rollback()
                throw e
            } finally {
                conn.autoCommit = true
            }
        }
    }

    fun execute(sql: String, vararg params: Any?) {
        withConnection { conn ->
            conn.prepareStatement(sql).use { stmt ->
                params.forEachIndexed { index, param ->
                    stmt.setObject(index + 1, param)
                }
                stmt.executeUpdate()
            }
        }
    }

    fun executeUpdate(sql: String, vararg params: Any?): Int {
        return withConnection { conn ->
            conn.prepareStatement(sql).use { stmt ->
                params.forEachIndexed { index, param ->
                    stmt.setObject(index + 1, param)
                }
                stmt.executeUpdate()
            }
        }
    }

    fun <T> query(sql: String, vararg params: Any?, mapper: (ResultSet) -> T): List<T> {
        return withConnection { conn ->
            conn.prepareStatement(sql).use { stmt ->
                params.forEachIndexed { index, param ->
                    stmt.setObject(index + 1, param)
                }
                stmt.executeQuery().use { rs ->
                    val results = mutableListOf<T>()
                    while (rs.next()) {
                        results.add(mapper(rs))
                    }
                    results
                }
            }
        }
    }

    fun <T> queryOne(sql: String, vararg params: Any?, mapper: (ResultSet) -> T): T? {
        return withConnection { conn ->
            conn.prepareStatement(sql).use { stmt ->
                params.forEachIndexed { index, param ->
                    stmt.setObject(index + 1, param)
                }
                stmt.executeQuery().use { rs ->
                    if (rs.next()) mapper(rs) else null
                }
            }
        }
    }

    fun queryInt(sql: String, vararg params: Any?): Int {
        return queryOne(sql, *params) { it.getInt(1) } ?: 0
    }

    /**
     * Execute an insert and return the generated key.
     */
    fun insertReturningId(sql: String, vararg params: Any?): Int {
        return withConnection { conn ->
            conn.prepareStatement(sql, java.sql.Statement.RETURN_GENERATED_KEYS).use { stmt ->
                params.forEachIndexed { index, param ->
                    stmt.setObject(index + 1, param)
                }
                stmt.executeUpdate()
                stmt.generatedKeys.use { rs ->
                    if (rs.next()) rs.getInt(1) else throw RuntimeException("No generated key")
                }
            }
        }
    }

    fun close() {
        dataSource.close()
    }
}
