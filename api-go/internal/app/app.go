package app

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/cymoo/mita"

	"github.com/cymoo/mote/assets"
	"github.com/cymoo/mote/internal/config"
	"github.com/cymoo/mote/internal/services"
	"github.com/cymoo/mote/internal/tasks"
	"github.com/cymoo/mote/pkg/fulltext"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/sqlite"
	"github.com/golang-migrate/migrate/v4/source/iofs"

	"github.com/jmoiron/sqlx"
	_ "modernc.org/sqlite"

	"github.com/redis/go-redis/v9"
)

type App struct {
	config *config.Config
	db     *sqlx.DB
	redis  *redis.Client
	fts    *fulltext.FullTextSearch
	tm     *mita.TaskManager
	server *http.Server
}

// New creates a new App instance with the given configuration
func New(cfg *config.Config) *App {
	app := &App{config: cfg}
	if err := app.initialize(); err != nil {
		panic(err)
	}
	return app
}

// Initialize sets up the application, including database, redis, routes, and tasks
func (app *App) initialize() error {
	configJSON, err := app.config.ToJSON(true)
	if err != nil {
		return err
	}
	log.Printf("app config:\n%s", configJSON)
	log.Println("=================================")

	if err := app.initDatabase(); err != nil {
		return fmt.Errorf("failed to initialize database: %w", err)
	}

	if err := app.initRedis(); err != nil {
		return fmt.Errorf("failed to initialize redis: %w", err)
	}

	if err := app.initFullTextSearch(); err != nil {
		return fmt.Errorf("failed to initialize full-text search: %w", err)
	}

	if err := app.setupTasks(); err != nil {
		return fmt.Errorf("failed to add tasks: %w", err)
	}

	app.setupRoutes()

	return nil
}

// initDatabase initializes the database connection and runs migrations if enabled
func (app *App) initDatabase() error {
	if app.config.DB.AutoMigrate {
		log.Println("running database migrations...")
		if err := runMigrations(app.config.DB.URL); err != nil {
			return fmt.Errorf("failed to run migrations: %w", err)
		}
	}

	db, err := sqlx.Connect("sqlite", app.config.DB.URL)
	if err != nil {
		log.Printf("database connection error: %v", app.config.DB.URL)
		return fmt.Errorf("failed to connect to database: %w", err)
	}

	_, err = db.Exec("PRAGMA foreign_keys = ON")
	if err != nil {
		return fmt.Errorf("failed to enable foreign keys: %w", err)
	}

	_, err = db.Exec("PRAGMA journal_mode = WAL")
	if err != nil {
		return fmt.Errorf("failed to enable WAL mode: %w", err)
	}

	// Avoid SQLITE_BUSY under concurrent writes (e.g. parallel chunk uploads).
	// SQLite serialises writers; without a busy timeout, contending writers
	// fail immediately instead of waiting for the lock to be released.
	if _, err = db.Exec("PRAGMA busy_timeout = 5000"); err != nil {
		return fmt.Errorf("failed to set busy_timeout: %w", err)
	}

	verifyForeignKeysConstraints(db)
	verifyWALMode(db)

	// Configure connection pool
	poolSize := app.config.DB.PoolSize
	db.SetMaxOpenConns(poolSize)
	db.SetMaxIdleConns(poolSize)
	db.SetConnMaxIdleTime(0)
	db.SetConnMaxLifetime(0)

	// Test connection
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := db.PingContext(ctx); err != nil {
		return fmt.Errorf("database ping failed: %w", err)
	}

	app.db = db
	log.Println("database connection established successfully")
	return nil
}

// initRedis initializes the Redis client and tests the connection
func (app *App) initRedis() error {
	app.redis = redis.NewClient(&redis.Options{
		Addr:     app.config.Redis.URL,
		Password: app.config.Redis.Password,
		DB:       app.config.Redis.DB,
	})

	// Test connection
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := app.redis.Ping(ctx).Err(); err != nil {
		return err
	}

	log.Println("redis connection established successfully")
	return nil
}

// initFullTextSearch initializes the full-text search engine
func (app *App) initFullTextSearch() error {
	app.fts = fulltext.NewFullTextSearch(
		app.redis,
		fulltext.NewGseTokenizer(),
		"fts:",
	)
	log.Println("full-text search initialized successfully")
	return nil
}

// setupTasks sets up the background tasks using mita
func (app *App) setupTasks() error {
	tm := mita.New()

	tm.SetContextValue("db", app.db)
	tm.SetContextValue("fts", app.fts)
	tm.SetContextValue("upload_path", app.config.Upload.BasePath)

	// delete old posts daily at 2:00 AM
	if err := tm.AddTask("delete-old-posts", mita.Every().Day().At(2, 0), tasks.DeleteOldPosts); err != nil {
		return err
	}

	// purge expired drive upload sessions hourly
	if err := tm.AddTask("purge-drive-uploads", mita.Every().Hour(), tasks.PurgeExpiredDriveUploads); err != nil {
		return err
	}

	// hard-delete drive trash older than 30 days, daily at 2:30 AM
	if err := tm.AddTask("purge-drive-trash", mita.Every().Day().At(2, 30), tasks.PurgeOldDriveTrash); err != nil {
		return err
	}

	// rebuild full-text index on the first day of each month at 2:00 AM
	if err := tm.AddTask("rebuild-fulltext-index", mita.Every().Day().At(2, 0).OnDay(1), tasks.RebuildFullTextIndex); err != nil {
		return err
	}

	app.tm = tm

	return nil
}

// setupRoutes configures the HTTP routes and middleware
func (app *App) setupRoutes() {
	r := chi.NewRouter()

	// Setup middleware
	if app.config.Log.LogRequests {
		r.Use(middleware.Logger)
	}

	appEnv := app.config.AppEnv
	r.Use(PanicRecovery(appEnv == "development" || appEnv == "dev"))
	r.Use(CORS(app.config.HTTP.CORS))

	// Serve uploaded files (auth required)
	uploadUrl := app.config.Upload.BaseURL
	uploadPath := app.config.Upload.BasePath
	authService := services.NewAuthService()
	r.With(SimpleAuthCheck(authService)).Handle(uploadUrl+"/*", http.StripPrefix(uploadUrl, http.FileServer(http.Dir(uploadPath))))

	// Serve static files
	staticUrl := app.config.StaticURL
	staticPath := app.config.StaticPath

	// Serve from embedded FS if no static path is set
	var staticFs http.FileSystem
	if staticPath == "" {
		staticFs = http.FS(assets.StaticFS())
	} else {
		staticFs = http.Dir(staticPath)
	}

	r.Handle(staticUrl+"/*", http.StripPrefix(staticUrl, http.FileServer(staticFs)))

	// Health check endpoint
	r.Get("/health", app.checkHealth)

	// Mount task web ui
	r.Mount("/", app.tm.WebHandler("/tasks"))

	// Mount API and page routers
	r.Mount("/api", NewApiRouter(app))
	r.Mount("/shared", NewPageRouter(app))

	// Mount public file-share router (no auth, no /api prefix).
	driveSvc := services.NewDriveService(app.db, &app.config.Upload)
	driveShareSvc := services.NewDriveShareService(app.db, driveSvc)
	r.Mount("/shared-files", NewPublicShareRouter(driveSvc, driveShareSvc, app.redis))

	// HTTP server: drive uploads/downloads can stream large files; use a
	// generous WriteTimeout to avoid premature termination.
	writeTimeout := app.config.HTTP.WriteTimeout
	if writeTimeout < 5*time.Minute {
		writeTimeout = 5 * time.Minute
	}

	// Create HTTP server
	app.server = &http.Server{
		Addr:         fmt.Sprintf("%s:%d", app.config.HTTP.IP, app.config.HTTP.Port),
		Handler:      r,
		ReadTimeout:  app.config.HTTP.ReadTimeout,
		WriteTimeout: writeTimeout,
		IdleTimeout:  app.config.HTTP.IdleTimeout,
	}
}

// checkHealth handles the /health endpoint to report application health status
func (app *App) checkHealth(w http.ResponseWriter, r *http.Request) {
	// Check database connection
	if err := app.db.Ping(); err != nil {
		http.Error(w, "database not available", http.StatusServiceUnavailable)
		return
	}

	// Check redis connection
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := app.redis.Ping(ctx).Err(); err != nil {
		http.Error(w, "redis not available", http.StatusServiceUnavailable)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"status": "healthy"}`))
}

// Run starts the HTTP server and listens for shutdown signals
func (app *App) Run() error {
	// Start background tasks
	app.tm.Start()

	go func() {
		log.Printf("server starting on %s", app.server.Addr)
		if err := app.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server failed to start: %v", err)
		}
	}()

	// Wait for interrupt signal to gracefully shutdown the server
	// Catch SIGINT and SIGTERM
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("shutting down server...")
	return app.Shutdown()
}

// Shutdown cleans up resources and gracefully shuts down the server
func (app *App) Shutdown() error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Stop background tasks
	app.tm.Stop()

	// Gracefully shutdown the server
	if err := app.server.Shutdown(ctx); err != nil {
		return fmt.Errorf("server shutdown failed: %w", err)
	}

	// Close database connection
	if app.db != nil {
		if err := app.db.Close(); err != nil {
			return fmt.Errorf("database connection close failed: %w", err)
		}
	}

	// Close redis connection
	if app.redis != nil {
		if err := app.redis.Close(); err != nil {
			return fmt.Errorf("redis connection close failed: %w", err)
		}
	}

	log.Println("server shutdown completed")
	return nil
}

func (app *App) GetDB() *sqlx.DB {
	return app.db
}

func (app *App) GetRedis() *redis.Client {
	return app.redis
}

func (app *App) GetFTS() *fulltext.FullTextSearch {
	return app.fts
}

// verifyForeignKeysConstraints checks if foreign key constraints are enabled
func verifyForeignKeysConstraints(db *sqlx.DB) {
	var rv int
	err := db.Get(&rv, "PRAGMA foreign_keys;")
	if err != nil {
		panic("failed to verify foreign keys constraints: " + err.Error())
	}
	if rv != 1 {
		panic("foreign keys constraints are not enabled")
	}
}

// verifyWALMode checks if the database is in WAL mode
func verifyWALMode(db *sqlx.DB) {
	var rv string
	err := db.Get(&rv, "PRAGMA journal_mode;")
	if err != nil {
		panic("failed to verify WAL mode: " + err.Error())
	}
	if rv != "wal" {
		panic("WAL mode is not enabled")
	}
}

// runMigrations applies database migrations using embedded migration files
func runMigrations(url string) error {
	iofsDriver, err := iofs.New(assets.MigrationFS(), "migrations")
	if err != nil {
		return fmt.Errorf("failed to create iofs driver: %w", err)
	}

	migrator, err := migrate.NewWithSourceInstance(
		"iofs",
		iofsDriver,
		"sqlite://"+url,
	)
	if err != nil {
		return fmt.Errorf("failed to create migrator: %w", err)
	}

	defer migrator.Close()

	err = migrator.Up()
	switch {
	case errors.Is(err, migrate.ErrNoChange):
		return nil
	case err != nil:
		return fmt.Errorf("migration failed: %w", err)
	default:
		log.Println("migrations applied successfully")
		return nil
	}
}
