package app

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/cymoo/mote/assets"
	mw "github.com/cymoo/mote/internal/middlewares"
	"github.com/cymoo/mote/internal/services"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

// setupRoutes configures the HTTP routes and middleware.
func (app *App) setupRoutes() {
	r := chi.NewRouter()

	if app.config.Log.LogRequests {
		r.Use(middleware.Logger)
	}

	appEnv := app.config.AppEnv
	r.Use(mw.PanicRecovery(appEnv == "development" || appEnv == "dev"))
	r.Use(mw.CORS(app.config.HTTP.CORS))

	uploadURL := app.config.Upload.BaseURL
	uploadPath := app.config.Upload.BasePath
	authService := services.NewAuthService()
	r.With(mw.SimpleAuthCheck(authService)).Handle(uploadURL+"/*", http.StripPrefix(uploadURL, http.FileServer(http.Dir(uploadPath))))

	staticURL := app.config.StaticURL
	staticPath := app.config.StaticPath

	var staticFS http.FileSystem
	if staticPath == "" {
		staticFS = http.FS(assets.StaticFS())
	} else {
		staticFS = http.Dir(staticPath)
	}

	r.Handle(staticURL+"/*", http.StripPrefix(staticURL, http.FileServer(staticFS)))
	r.Get("/health", app.checkHealth)
	r.Mount("/", app.tm.WebHandler("/tasks"))
	r.Mount("/api", NewApiRouter(app))
	r.Mount("/shared", NewBlogRouter(app))

	driveSvc := services.NewDriveService(app.db, &app.config.Upload)
	driveShareSvc := services.NewDriveShareService(app.db, driveSvc)
	r.Mount("/shared-files", NewPublicShareRouter(driveSvc, driveShareSvc, app.redis))

	app.server = &http.Server{
		Addr:         fmt.Sprintf("%s:%d", app.config.HTTP.IP, app.config.HTTP.Port),
		Handler:      r,
		ReadTimeout:  app.config.HTTP.ReadTimeout,
		WriteTimeout: app.config.HTTP.WriteTimeout,
		IdleTimeout:  app.config.HTTP.IdleTimeout,
	}
}

// checkHealth handles the /health endpoint to report application health status.
func (app *App) checkHealth(w http.ResponseWriter, r *http.Request) {
	if err := app.db.Ping(); err != nil {
		http.Error(w, "database not available", http.StatusServiceUnavailable)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := app.redis.Ping(ctx).Err(); err != nil {
		http.Error(w, "redis not available", http.StatusServiceUnavailable)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"status": "healthy"}`))
}
