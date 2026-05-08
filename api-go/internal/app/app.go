package app

import (
	"fmt"
	"log"
	"net/http"

	"github.com/cymoo/mita"

	"github.com/cymoo/mote/internal/config"
	"github.com/cymoo/mote/pkg/fulltext"

	"github.com/jmoiron/sqlx"
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

// New creates a new App instance with the given configuration.
func New(cfg *config.Config) (*App, error) {
	app := &App{config: cfg}
	if err := app.initialize(); err != nil {
		return nil, err
	}
	return app, nil
}

// Initialize sets up the application, including database, redis, routes, and tasks
func (app *App) initialize() error {
	if err := app.config.EnsureUploadPath(); err != nil {
		return fmt.Errorf("failed to initialize upload path: %w", err)
	}

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

func (app *App) GetDB() *sqlx.DB {
	return app.db
}

func (app *App) GetRedis() *redis.Client {
	return app.redis
}

func (app *App) GetFTS() *fulltext.FullTextSearch {
	return app.fts
}
