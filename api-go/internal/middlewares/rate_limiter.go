package middlewares

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"time"

	e "github.com/cymoo/mote/internal/errors"
	"github.com/redis/go-redis/v9"
)

// RateLimit returns a net/http middleware that enforces rate limiting, using Redis as the backend
// client: Redis client
// expires: duration for rate limit window
// maxCount: maximum number of requests allowed within the window
func RateLimit(client *redis.Client, expires time.Duration, maxCount int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			key := fmt.Sprintf("rate:%s", r.URL.Path)

			belowLimit, err := checkRateLimit(r.Context(), client, key, expires, maxCount)
			if err != nil {
				log.Printf("error checking rate limit: %v", err)
				e.SendJSONError(w, 500, "internal_error")
				return
			}

			if !belowLimit {
				e.SendJSONError(w, http.StatusTooManyRequests, "too_many_attempts")
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

// checkRateLimit checks if the rate limit for the given key has been exceeded
func checkRateLimit(ctx context.Context, client *redis.Client, key string, expires time.Duration, maxCount int64) (bool, error) {
	pipe := client.Pipeline()

	// SET key 0 EX expires NX (only set if not exists)
	pipe.SetNX(ctx, key, 0, expires)

	// INCR key
	incrCmd := pipe.Incr(ctx, key)

	// Execute pipeline
	_, err := pipe.Exec(ctx)
	if err != nil && err != redis.Nil {
		return false, fmt.Errorf("redis pipeline error: %w", err)
	}

	// Get the incremented value
	count, err := incrCmd.Result()
	if err != nil {
		return false, fmt.Errorf("failed to get incr result: %w", err)
	}

	return count <= maxCount, nil
}
