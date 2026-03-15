package site.daydream.mote.service

import com.fasterxml.jackson.core.type.TypeReference
import com.fasterxml.jackson.databind.ObjectMapper
import redis.clients.jedis.*
import redis.clients.jedis.params.ScanParams
import site.daydream.mote.config.RedisConfig
import java.time.Duration

class RedisService(config: RedisConfig, val objectMapper: ObjectMapper) {
    private val jedis: JedisPooled

    init {
        val poolConfig = ConnectionPoolConfig().apply {
            maxTotal = config.maxTotal
            maxIdle = config.maxIdle
            minIdle = 0
            testOnBorrow = true
            testWhileIdle = true
            testOnReturn = false
            blockWhenExhausted = true
            setMaxWait(Duration.ofMillis(3000))
        }

        val uri = java.net.URI.create(config.url)
        jedis = JedisPooled(poolConfig, uri)
    }

    fun set(key: String, value: String): String = jedis.set(key, value)

    fun get(key: String): String? = jedis.get(key)

    fun del(vararg keys: String): Long = jedis.del(*keys)

    fun incr(key: String): Long = jedis.incr(key)

    fun decr(key: String): Long = jedis.decr(key)

    fun sadd(key: String, vararg members: String): Long = jedis.sadd(key, *members)

    fun smembers(key: String): Set<String> = jedis.smembers(key)

    fun srem(key: String, vararg members: String): Long = jedis.srem(key, *members)

    fun scard(key: String): Long = jedis.scard(key)

    fun exists(key: String): Boolean = jedis.exists(key)

    fun mget(keys: List<String>): List<String?> {
        if (keys.isEmpty()) return emptyList()
        return jedis.mget(*keys.toTypedArray())
    }

    fun <T : Any> mgetObject(keys: List<String>, typeReference: TypeReference<T>): List<T?> {
        if (keys.isEmpty()) return emptyList()
        return jedis.mget(*keys.toTypedArray()).map {
            if (it != null) objectMapper.readValue(it, typeReference)
            else null
        }
    }

    fun <T> getObject(key: String, typeReference: TypeReference<T>): T? {
        return get(key)?.let { objectMapper.readValue(it, typeReference) }
    }

    fun deleteByPrefix(prefix: String, batchSize: Int = 100): Long {
        var deletedCount = 0L
        var cursor = ScanParams.SCAN_POINTER_START
        val scanParams = ScanParams().match("$prefix*").count(batchSize)

        do {
            val scanResult = jedis.scan(cursor, scanParams)
            val keys = scanResult.result

            if (keys.isNotEmpty()) {
                val deleted = jedis.del(*keys.toTypedArray())
                deletedCount += deleted
            }

            cursor = scanResult.cursor
        } while (cursor != ScanParams.SCAN_POINTER_START)

        return deletedCount
    }

    fun multi(callback: (AbstractTransaction).() -> Any) {
        jedis.multi().use { tx ->
            try {
                tx.callback()
                tx.exec()
            } catch (e: Exception) {
                tx.discard()
                throw RuntimeException("Failed to execute Redis transaction", e)
            }
        }
    }

    fun <T> pipeline(
        callback: (AbstractPipeline) -> T
    ): T {
        return jedis.pipelined().use { pipe ->
            val result = callback(pipe)
            pipe.sync()
            result
        }
    }

    fun close() {
        jedis.close()
    }
}
