package middlewares

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/cymoo/mote/internal/config"
)

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
