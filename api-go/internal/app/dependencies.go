package app

import (
	"context"
	"log"
	"time"

	"github.com/cymoo/mote/pkg/fulltext"
	"github.com/redis/go-redis/v9"
)

// initRedis initializes the Redis client and tests the connection.
func (app *App) initRedis() error {
	app.redis = redis.NewClient(&redis.Options{
		Addr:     app.config.Redis.URL,
		Password: app.config.Redis.Password,
		DB:       app.config.Redis.DB,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := app.redis.Ping(ctx).Err(); err != nil {
		return err
	}

	log.Println("redis connection established successfully")
	return nil
}

// initFullTextSearch initializes the full-text search engine.
func (app *App) initFullTextSearch() error {
	app.fts = fulltext.NewFullTextSearch(
		app.redis,
		fulltext.NewGseTokenizer(),
		"fts:",
	)
	log.Println("full-text search initialized successfully")
	return nil
}
