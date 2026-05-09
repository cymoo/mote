package middlewares

import (
	"net/http"
	"strings"

	e "github.com/cymoo/mote/internal/errors"
	"github.com/cymoo/mote/internal/services"
)

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
