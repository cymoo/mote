# Mote API - Colleen Backend

A lightweight notebook API backend built with the [Colleen](https://github.com/cymoo/colleen) web framework.

## Tech Stack

- **Framework**: [Colleen](https://github.com/cymoo/colleen) - A lightweight web framework for Kotlin
- **Task Scheduling**: [Cleary](https://github.com/cymoo/cleary) - A lightweight task scheduler for Kotlin
- **Database**: SQLite (via JDBC + HikariCP)
- **Migrations**: Flyway
- **Cache/Search**: Redis (via Lettuce)
- **Template Engine**: Pebble
- **JSON**: Jackson
- **Image Processing**: Thumbnailator + metadata-extractor
- **Java**: 21+ (virtual threads)

## Prerequisites

- Java 21+
- Maven 3.6+
- Redis server

## Quick Start

```bash
# Set password (required)
export MOTE_PASSWORD=your_password

# Run directly
make run

# Or with Maven
mvn exec:java -Dexec.mainClass="site.daydream.mote.AppKt"
```

The server starts at `http://127.0.0.1:8000` by default.

## Build

```bash
# Build fat JAR
make build

# Run the JAR
MOTE_PASSWORD=your_password java -jar target/api-colleen-1.0.0.jar
```

## Configuration

Configuration is done via environment variables or `.env` file:

| Variable | Default | Description |
|----------|---------|-------------|
| `MOTE_PASSWORD` | (required) | Authentication password |
| `HTTP_IP` | `127.0.0.1` | Server bind address |
| `HTTP_PORT` | `8000` | Server port |
| `DATABASE_URL` | `sqlite:app.db` | SQLite database path |
| `DATABASE_AUTO_MIGRATE` | `true` | Run migrations on startup |
| `REDIS_URL` | `redis://localhost:6379/0` | Redis connection URL |
| `UPLOAD_PATH` | `uploads` | File upload directory |
| `CORS_ALLOWED_ORIGINS` | `*` | CORS allowed origins |
| `LOG_REQUESTS` | `true` | Enable request logging |

## Testing

```bash
make test
```

## Project Structure

```
api-colleen/
├── src/main/kotlin/site/daydream/mote/
│   ├── App.kt                    # Application entry point
│   ├── config/                   # Configuration classes
│   ├── controller/               # Route controllers
│   │   ├── PostApiController.kt  # REST API endpoints
│   │   ├── PostPageController.kt # Shared post HTML pages
│   │   └── MigrationController.kt
│   ├── middleware/               # Custom middleware
│   │   └── AuthMiddleware.kt    # Authentication
│   ├── model/                   # Data models & DTOs
│   ├── service/                 # Business logic
│   │   ├── PostService.kt      # Post CRUD operations
│   │   ├── TagService.kt       # Tag management
│   │   ├── SearchService.kt    # Full-text search (Redis)
│   │   ├── TaskService.kt      # Background tasks (Cleary)
│   │   ├── DatabaseService.kt  # JDBC database access
│   │   ├── RedisService.kt     # Redis client wrapper
│   │   ├── UploadService.kt    # File upload handling
│   │   └── AuthService.kt      # Authentication
│   ├── exception/               # Custom exceptions
│   └── util/                    # Utilities
├── src/main/resources/
│   ├── db/migration/            # Flyway SQL migrations
│   ├── static/                  # CSS/JS static files
│   ├── templates/               # Pebble HTML templates
│   └── logback.xml              # Logging configuration
├── pom.xml                      # Maven configuration
├── .env                         # Environment variables
├── Makefile                     # Build commands
└── README.md
```
