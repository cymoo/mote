package app

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"runtime/debug"
	"strconv"
	"strings"
	"time"

	"github.com/cymoo/mote/internal/config"
	e "github.com/cymoo/mote/internal/errors"
	"github.com/cymoo/mote/internal/services"
	"github.com/redis/go-redis/v9"
)

// PanicRecovery handle panic and return 500 error
// logTrace: whether to log stack trace
func PanicRecovery(logTrace bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if err := recover(); err != nil {
					log.Printf("panic recovered: %v\n", err)
					if logTrace {
						log.Printf("stack trace:\n%s", debug.Stack())
					}
					e.SendJSONError(w, 500, "internal_error")
				}
			}()

			next.ServeHTTP(w, r)
		})
	}
}

// CORS returns a net/http middleware that handles CORS requests
// config: CORS configuration
func CORS(config config.CORSConfig) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")

			// If no origins are specified, allow all origins
			if len(config.AllowedOrigins) == 0 {
				w.Header().Set("Access-Control-Allow-Origin", "*")
			} else {
				// Check if the request origin is in the allowed list
				for _, allowedOrigin := range config.AllowedOrigins {
					if allowedOrigin == "*" || allowedOrigin == origin {
						w.Header().Set("Access-Control-Allow-Origin", origin)
						break
					}
				}
			}
			// Set allowed methods
			methods := "GET, POST, PUT, DELETE, OPTIONS"
			if len(config.AllowedMethods) > 0 {
				methods = strings.Join(config.AllowedMethods, ", ")
			}
			w.Header().Set("Access-Control-Allow-Methods", methods)

			// Set default headers if none specified
			headers := "Content-Type, Authorization"
			if len(config.AllowedHeaders) > 0 {
				headers = strings.Join(config.AllowedHeaders, ", ")
			}
			w.Header().Set("Access-Control-Allow-Headers", headers)

			// Set Allow-Credentials header
			if config.AllowCredentials {
				w.Header().Set("Access-Control-Allow-Credentials", "true")
			}

			// Set Access-Control-Max-Age header
			if config.MaxAge > 0 {
				w.Header().Set("Access-Control-Max-Age", strconv.Itoa(config.MaxAge))
			}

			// Handle preflight requests
			if r.Method == "OPTIONS" {
				w.WriteHeader(http.StatusNoContent)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

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

// SimpleAuthCheck returns a net/http middleware that checks for a valid token
// authService: service to validate tokens
// excludedPaths: paths to exclude from authentication
func SimpleAuthCheck(authService *services.AuthService, excludedPaths ...string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			path := r.URL.Path

			// check if the path should be skipped
			if shouldExclude(path, excludedPaths) {
				next.ServeHTTP(w, r)
				return
			}

			// try to get token from cookie or Authorization header
			token := getTokenFromCookie(r, "token")
			if token == "" {
				token = extractBearerToken(r)
			}

			// if no token provided, return 401
			if token == "" {
				e.SendJSONError(w, 401, "unauthorized", "no token provided")
				return
			}

			// validate the token, return 401 if invalid
			if !authService.IsValidToken(token) {
				e.SendJSONError(w, 401, "unauthorized", "invalid token")
				return
			}

			// valid token, proceed to next handler
			next.ServeHTTP(w, r)
		})
	}
}

// shouldExclude checks if the given path matches any of the skip paths
func shouldExclude(path string, skipPaths []string) bool {
	for _, skipPath := range skipPaths {
		if strings.HasPrefix(path, skipPath) {
			return true
		}
	}
	return false
}

// extractBearerToken extracts the Bearer token from the Authorization header
func extractBearerToken(r *http.Request) string {
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		return ""
	}

	// check if it starts with "Bearer "
	const bearerPrefix = "Bearer "
	if !strings.HasPrefix(authHeader, bearerPrefix) {
		return ""
	}

	return strings.TrimPrefix(authHeader, bearerPrefix)
}

// getTokenFromCookie retrieves the token from the specified cookie
func getTokenFromCookie(r *http.Request, name string) string {
	cookie, err := r.Cookie(name)
	if err != nil {
		return ""
	}
	return cookie.Value
}
