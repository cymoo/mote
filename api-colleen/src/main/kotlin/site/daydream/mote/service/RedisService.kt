package site.daydream.mote.service

import com.fasterxml.jackson.core.type.TypeReference
import com.fasterxml.jackson.databind.ObjectMapper
import io.lettuce.core.LettuceFutures
import io.lettuce.core.RedisClient
import io.lettuce.core.RedisFuture
import io.lettuce.core.ScanArgs
import io.lettuce.core.ScanCursor
import io.lettuce.core.api.StatefulRedisConnection
import io.lettuce.core.api.async.RedisAsyncCommands
import io.lettuce.core.api.sync.RedisCommands
import io.lettuce.core.support.ConnectionPoolSupport
import org.apache.commons.pool2.impl.GenericObjectPool
import org.apache.commons.pool2.impl.GenericObjectPoolConfig
import site.daydream.mote.config.RedisConfig
import java.time.Duration

class RedisService(config: RedisConfig, val objectMapper: ObjectMapper) {
    private val client: RedisClient = RedisClient.create(config.url)
    private val pool: GenericObjectPool<StatefulRedisConnection<String, String>>

    init {
        val poolConfig = GenericObjectPoolConfig<StatefulRedisConnection<String, String>>().apply {
            maxTotal = config.maxTotal
            maxIdle = config.maxIdle
        }
        pool = ConnectionPoolSupport.createGenericObjectPool({ client.connect() }, poolConfig)
    }

    fun set(key: String, value: String): String = executeSync { it.set(key, value) }

    fun get(key: String): String? = executeSync { it.get(key) }

    fun del(vararg keys: String): Long = executeSync { it.del(*keys) }

    fun incr(key: String): Long = executeSync { it.incr(key) }

    fun decr(key: String): Long = executeSync { it.decr(key) }

    fun sadd(key: String, vararg members: String): Long = executeSync { it.sadd(key, *members) }

    fun smembers(key: String): Set<String> = executeSync { it.smembers(key) }

    fun srem(key: String, vararg members: String): Long = executeSync { it.srem(key, *members) }

    fun scard(key: String): Long = executeSync { it.scard(key) }

    fun exists(key: String): Boolean = executeSync { it.exists(key) != 0L }

    fun mget(keys: List<String>): List<String?> {
        return executeSync { it.mget(*keys.toTypedArray()) }
            .map { if (it.hasValue()) it.value else null }
    }

    inline fun <reified T : Any> mgetObject(keys: List<String>): List<T?> {
        val typeReference = object : TypeReference<T>() {}
        return executeSync { it.mget(*keys.toTypedArray()) }
            .map {
                if (it.hasValue()) objectMapper.readValue(it.value, typeReference)
                else null
            }
    }

    inline fun <reified T> getObject(key: String): T? {
        val typeReference = object : TypeReference<T>() {}
        return get(key)?.let { objectMapper.readValue(it, typeReference) }
    }

    fun deleteByPrefix(prefix: String, batchSize: Long = 100): Long {
        return executeSync {
            var deletedCount = 0L
            var cursor = ScanCursor.INITIAL
            val scanArgs = ScanArgs.Builder.matches("$prefix*").limit(batchSize)

            do {
                val scanResult = it.scan(cursor, scanArgs)
                val keys = scanResult.keys

                if (keys.isNotEmpty()) {
                    val deleted = it.del(*keys.toTypedArray())
                    deletedCount += deleted
                }

                cursor = scanResult
            } while (!cursor.isFinished)

            deletedCount
        }
    }

    fun multi(callback: (RedisCommands<String, String>).() -> Any) {
        pool.borrowObject().use { conn ->
            val commands = conn.sync()
            try {
                commands.multi()
                commands.callback()
                commands.exec()
            } catch (e: Exception) {
                commands.discard()
                throw RuntimeException("Failed to execute Redis command", e)
            }
        }
    }

    fun <R> pipeline(
        timeout: Duration = Duration.ofSeconds(5),
        callback: RedisAsyncCommands<String, String>.() -> List<RedisFuture<R>>
    ): List<R> {
        return pool.borrowObject().use { conn ->
            try {
                conn.setAutoFlushCommands(false)
                val futures = conn.async().callback()
                conn.flushCommands()
                val success = LettuceFutures.awaitAll(timeout, *futures.toTypedArray())
                if (!success) {
                    throw RuntimeException("Pipeline execution timed out after ${timeout.seconds} seconds")
                }
                futures.map { it.get() }
            } catch (e: Exception) {
                throw RuntimeException("Failed to execute Redis commands", e)
            } finally {
                conn.setAutoFlushCommands(true)
            }
        }
    }

    inline fun <R> executeSync(crossinline callback: (RedisCommands<String, String>) -> R): R {
        return try {
            pool.borrowObject().use { conn ->
                conn.setAutoFlushCommands(true)
                callback(conn.sync())
            }
        } catch (e: Exception) {
            throw RuntimeException("Failed to execute Redis command", e)
        }
    }

    fun close() {
        pool.close()
        client.shutdown()
    }

    private fun <T : AutoCloseable> GenericObjectPool<T>.borrowObject(): PooledResource<T> {
        val obj = this.borrowObject()
        return PooledResource(this, obj)
    }
}

private class PooledResource<T : AutoCloseable>(
    private val pool: GenericObjectPool<T>,
    val resource: T
) : AutoCloseable {
    override fun close() {
        pool.returnObject(resource)
    }
}

private fun <T : AutoCloseable, R> PooledResource<T>.use(block: (T) -> R): R {
    return try {
        block(this.resource)
    } finally {
        this.close()
    }
}
