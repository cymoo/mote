package site.daydream.mote

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.PropertyNamingStrategies
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule
import com.fasterxml.jackson.module.kotlin.KotlinModule
import io.github.cymoo.colleen.Colleen
import io.github.cymoo.colleen.middleware.Cors
import io.github.cymoo.colleen.middleware.RequestLogger
import io.github.cymoo.colleen.middleware.ServeStatic
import org.slf4j.LoggerFactory
import site.daydream.mote.config.*
import site.daydream.mote.controller.MigrationController
import site.daydream.mote.controller.PostApiController
import site.daydream.mote.controller.PostPageController
import site.daydream.mote.middleware.AuthMiddleware
import site.daydream.mote.middleware.PebbleRender
import site.daydream.mote.service.*
import site.daydream.mote.util.Env
import javax.imageio.ImageIO
import kotlin.system.exitProcess

private val logger = LoggerFactory.getLogger("site.daydream.mote.App")

fun main() {
    Env.load()

    val password = Env.get("MOTE_PASSWORD")
    if (password.isNullOrBlank()) {
        System.err.println("Error: MOTE_PASSWORD environment variable is missing.")
        exitProcess(1)
    }

    // Initialize ImageIO plugins (WebP support)
    ImageIO.scanForPlugins()

    // Load configurations
    val appConfig = AppConfig()
    val serverConfig = ServerConfig()
    val databaseConfig = DatabaseConfig()
    val redisConfig = RedisConfig()
    val corsConfig = CorsConfig()
    val uploadConfig = UploadConfig()

    // Initialize services
    val db = DatabaseService(databaseConfig)
    val dsl = db.dsl
    val authService = AuthService()

    val app = Colleen()

    // Configure JSON
    app.config.json {
        includeNulls = false
        failOnUnknownProperties = false
    }

    // Configure server
    app.config.server {
        host = serverConfig.host
        port = serverConfig.port
        maxRequestSize = 10L * 1024 * 1024 // 10MB
    }

    // Get the underlying ObjectMapper and configure it
    val jacksonMapper = app.config.jsonMapper as io.github.cymoo.colleen.json.JacksonMapper
    val objectMapper: ObjectMapper = jacksonMapper.mapper.apply {
        registerModule(KotlinModule.Builder().build())
        registerModule(JavaTimeModule())
        propertyNamingStrategy = PropertyNamingStrategies.SNAKE_CASE
    }

    // Initialize remaining services
    val redisService = RedisService(redisConfig, objectMapper)
    val searchService = SearchService(appConfig.searchKeyPrefix, redisService, objectMapper)
    val tagService = TagService(dsl)
    val postService = PostService(dsl, tagService, objectMapper)
    val uploadService = UploadService(uploadConfig)
    val taskService = TaskService(searchService, dsl)

    // Register services for DI
    app.provide(appConfig)
    app.provide(db)
    app.provide(objectMapper)
    app.provide(authService)
    app.provide(redisService)
    app.provide(searchService)
    app.provide(tagService)
    app.provide(postService)
    app.provide(uploadService)
    app.provide(taskService)

    // Global middleware
    if (Env.getBoolean("LOG_REQUESTS", true)) {
        app.use(RequestLogger())
    }

    // Template engine
    app.use(PebbleRender())

    // CORS for API
    app.use(Cors(
        allowOrigins = corsConfig.allowedOrigins.toSet(),
        allowMethods = corsConfig.allowedMethods.joinToString(", "),
        allowHeaders = corsConfig.allowedHeaders.joinToString(", "),
        allowCredentials = corsConfig.allowCredentials,
        maxAge = corsConfig.maxAge.toInt()
    ))

    // Static files serving (for uploads)
    app.use(ServeStatic(uploadConfig.uploadDir, "/${uploadConfig.uploadUrl}"))

    // Error handler for validation errors
    app.onError<IllegalArgumentException> { e, ctx ->
        ctx.status(400).json(mapOf(
            "code" to 400,
            "error" to "Bad Request",
            "message" to e.message
        ))
    }

    // Auth middleware for /api routes (excluding login)
    val authMiddleware = AuthMiddleware(
        authService,
        excludePaths = setOf("/login")
    )

    // Mount API routes with auth
    val apiApp = Colleen()
    apiApp.use(authMiddleware::invoke)
    apiApp.addController(PostApiController())
    app.mount("/api", apiApp)

    // Mount shared pages (no auth required)
    app.addController(PostPageController())

    // Mount migration controller
    app.addController(MigrationController())

    // Start task scheduler
    taskService.start()

    // Register shutdown hook
    Runtime.getRuntime().addShutdownHook(Thread {
        logger.info("Shutting down...")
        taskService.stop()
        redisService.close()
        db.close()
        logger.info("Shutdown complete")
    })

    logger.info("Starting Mote API on ${serverConfig.host}:${serverConfig.port}")
    app.listen(serverConfig.port, serverConfig.host)
}
