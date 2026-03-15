package site.daydream.mote.util

import java.io.File

object Env {
    private val logger = org.slf4j.LoggerFactory.getLogger(Env::class.java)

    fun load() {
        val filesToLoad = listOf(".env", ".env.local")

        val loadedVars = mutableMapOf<String, String>()
        filesToLoad.forEach { fileName ->
            val envFile = resolveEnvFile(fileName)
            if (envFile.exists()) {
                loadDotenvFile(envFile, loadedVars)
            }
        }

        loadedVars.forEach { (key, value) ->
            if (System.getenv(key) == null && System.getProperty(key) == null) {
                System.setProperty(key, value)
            }
        }
    }

    fun get(key: String): String? {
        return System.getenv(key) ?: System.getProperty(key)
    }

    fun get(key: String, default: String): String {
        return get(key) ?: default
    }

    fun getInt(key: String, default: Int): Int {
        return get(key)?.toIntOrNull() ?: default
    }

    fun getBoolean(key: String, default: Boolean): Boolean {
        return get(key)?.toBooleanStrictOrNull() ?: default
    }

    private fun resolveEnvFile(fileName: String): File {
        val projectRoot = System.getProperty("user.dir")
        return File(projectRoot, fileName)
    }

    private fun loadDotenvFile(file: File, accumulator: MutableMap<String, String>) {
        try {
            file.readLines().forEach { line ->
                val trimmed = line.trim()
                if (trimmed.isNotEmpty() && !trimmed.startsWith("#")) {
                    val idx = trimmed.indexOf('=')
                    if (idx > 0) {
                        val key = trimmed.substring(0, idx).trim()
                        val value = trimmed.substring(idx + 1).trim()
                            .removeSurrounding("\"")
                            .removeSurrounding("'")
                        accumulator[key] = value
                    }
                }
            }
            logger.info("Loaded environment file: ${file.name}")
        } catch (e: Exception) {
            logger.warn("Failed to load ${file.name}: ${e.message}")
        }
    }
}
