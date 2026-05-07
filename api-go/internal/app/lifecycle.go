package app

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// Run starts the HTTP server and listens for shutdown signals.
func (app *App) Run() error {
	app.tm.Start()

	go func() {
		log.Printf("server starting on %s", app.server.Addr)
		if err := app.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server failed to start: %v", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("shutting down server...")
	return app.Shutdown()
}

// Shutdown cleans up resources and gracefully shuts down the server.
func (app *App) Shutdown() error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	app.tm.Stop()

	if err := app.server.Shutdown(ctx); err != nil {
		return fmt.Errorf("server shutdown failed: %w", err)
	}

	if app.db != nil {
		if err := app.db.Close(); err != nil {
			return fmt.Errorf("database connection close failed: %w", err)
		}
	}

	if app.redis != nil {
		if err := app.redis.Close(); err != nil {
			return fmt.Errorf("redis connection close failed: %w", err)
		}
	}

	log.Println("server shutdown completed")
	return nil
}
