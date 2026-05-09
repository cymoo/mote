package middlewares

import (
	"log"
	"net/http"
	"runtime/debug"

	e "github.com/cymoo/mote/internal/errors"
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
