package app

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/url"
	"strings"
	"time"

	"github.com/cymoo/mote/assets"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/sqlite"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	"github.com/jmoiron/sqlx"
	_ "modernc.org/sqlite"
)

// initDatabase initializes the database connection and runs migrations if enabled.
func (app *App) initDatabase() error {
	if app.config.DB.AutoMigrate {
		log.Println("running database migrations...")
		if err := runMigrations(app.config.DB.URL); err != nil {
			return fmt.Errorf("failed to run migrations: %w", err)
		}
	}

	// Embed pragmas in the DSN so modernc.org/sqlite applies them to every
	// connection the pool creates, not just the first one. Without this,
	// busy_timeout is only set on one connection; concurrent upload inits
	// on other pool connections hit SQLITE_BUSY immediately and return 500.
	dsn := sqliteDSN(app.config.DB.URL, map[string]string{
		"busy_timeout": "5000",
		"journal_mode": "WAL",
		"foreign_keys": "ON",
	})
	db, err := sqlx.Connect("sqlite", dsn)
	if err != nil {
		log.Printf("database connection error: %v", app.config.DB.URL)
		return fmt.Errorf("failed to connect to database: %w", err)
	}

	verifyForeignKeysConstraints(db)
	verifyWALMode(db)

	poolSize := app.config.DB.PoolSize
	db.SetMaxOpenConns(poolSize)
	db.SetMaxIdleConns(poolSize)
	db.SetConnMaxIdleTime(0)
	db.SetConnMaxLifetime(0)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := db.PingContext(ctx); err != nil {
		return fmt.Errorf("database ping failed: %w", err)
	}

	app.db = db
	log.Println("database connection established successfully")
	return nil
}

// verifyForeignKeysConstraints checks if foreign key constraints are enabled.
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

// verifyWALMode checks if the database is in WAL mode.
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

// sqliteDSN appends _pragma query parameters to the given SQLite DSN so that
// modernc.org/sqlite applies them to every new connection it opens, not just
// the first one grabbed from the pool.
func sqliteDSN(dsn string, pragmas map[string]string) string {
	base, query, _ := strings.Cut(dsn, "?")
	q, _ := url.ParseQuery(query)
	for k, v := range pragmas {
		q.Add("_pragma", k+"("+v+")")
	}
	return base + "?" + q.Encode()
}

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
