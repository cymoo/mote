package middlewares

import (
	"fmt"
	"net/http"
	"sync"
	"time"

	e "github.com/cymoo/mote/internal/errors"
)

type windowEntry struct {
	count   int64
	resetAt time.Time
}

// RateLimit returns a net/http middleware that enforces rate limiting using an in-memory counter.
// expires: duration for rate limit window
// maxCount: maximum number of requests allowed within the window
func RateLimit(expires time.Duration, maxCount int64) func(http.Handler) http.Handler {
	var mu sync.Mutex
	store := make(map[string]*windowEntry)

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			key := fmt.Sprintf("rate:%s", r.URL.Path)

			if !checkRateLimit(&mu, store, key, expires, maxCount) {
				e.SendJSONError(w, http.StatusTooManyRequests, "too_many_attempts")
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

// checkRateLimit checks and increments the in-memory counter for the given key.
// Returns true if the request is within the limit.
func checkRateLimit(mu *sync.Mutex, store map[string]*windowEntry, key string, expires time.Duration, maxCount int64) bool {
	mu.Lock()
	defer mu.Unlock()

	now := time.Now()
	entry, ok := store[key]
	if !ok || !now.Before(entry.resetAt) {
		store[key] = &windowEntry{count: 1, resetAt: now.Add(expires)}
		return true
	}

	if entry.count >= maxCount {
		return false
	}
	entry.count++
	return true
}
