package site.daydream.mote.config

import site.daydream.mote.util.Env

data class AppConfig(
    val postsPerPage: Int = Env.getInt("POSTS_PER_PAGE", 20),
    val aboutUrl: String = Env.get("ABOUT_URL", ""),
    val searchKeyPrefix: String = Env.get("SEARCH_KEY_PREFIX", "fts:"),
)

data class ServerConfig(
    val host: String = Env.get("HTTP_IP", "127.0.0.1"),
    val port: Int = Env.getInt("HTTP_PORT", 8000),
)

data class DatabaseConfig(
    val url: String = Env.get("DATABASE_URL", "sqlite:app.db"),
    val poolSize: Int = Env.getInt("DATABASE_POOL_SIZE", 5),
    val autoMigrate: Boolean = Env.getBoolean("DATABASE_AUTO_MIGRATE", true),
) {
    val jdbcUrl: String
        get() = "jdbc:$url"
}

data class RedisConfig(
    val url: String = Env.get("REDIS_URL", "redis://localhost:6379/0"),
    val maxTotal: Int = 20,
    val maxIdle: Int = 5,
)

data class CorsConfig(
    val allowedOrigins: List<String> = Env.get("CORS_ALLOWED_ORIGINS", "*").split(","),
    val allowedMethods: List<String> = Env.get("CORS_ALLOWED_METHODS", "GET,POST,PUT,DELETE,OPTIONS").split(","),
    val allowedHeaders: List<String> = Env.get("CORS_ALLOWED_HEADERS", "Content-Type,Authorization").split(","),
    val allowCredentials: Boolean = Env.getBoolean("CORS_ALLOW_CREDENTIALS", false),
    val maxAge: Long = Env.get("CORS_MAX_AGE", "86400").toLong(),
)

data class UploadConfig(
    val uploadUrl: String = Env.get("UPLOAD_URL", "uploads"),
    val uploadDir: String = Env.get("UPLOAD_PATH", "uploads"),
    val thumbnailSize: Int = Env.getInt("UPLOAD_THUMB_WIDTH", 128),
    val imageFormats: List<String> = Env.get("UPLOAD_IMAGE_FORMATS", "jpeg,jpg,png,webp,gif").split(","),
)
