package config

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/cymoo/mote/pkg/util/env"
)

type Config struct {
	// Basic app info
	AppName    string
	AppVersion string
	AppEnv     string

	// Application settings
	PostsPerPage int
	StaticURL    string
	StaticPath   string

	// Server settings
	HTTP   HTTPConfig
	Upload UploadConfig

	DB    DBConfig
	Redis RedisConfig

	Log LogConfig
}

type UploadConfig struct {
	BaseURL             string
	BasePath            string
	AccelRedirectPrefix string
	ImageFormats        []string
	ThumbWidth          uint32
}

type DBConfig struct {
	URL         string
	PoolSize    int
	AutoMigrate bool
}

type RedisConfig struct {
	URL      string
	Password string
	DB       int
}

type CORSConfig struct {
	AllowedOrigins   []string
	AllowedMethods   []string
	AllowedHeaders   []string
	AllowCredentials bool
	MaxAge           int
}

type LogConfig struct {
	LogRequests bool
}

type HTTPConfig struct {
	IP           string
	Port         int
	MaxBodySize  int64
	ReadTimeout  time.Duration
	WriteTimeout time.Duration
	IdleTimeout  time.Duration
	CORS         CORSConfig
}

// Load loads the configuration from environment variables and config files
func Load() *Config {
	config := &Config{}

	config.AppEnv = env.GetString("APP_ENV", "prod")
	env.LoadConfigFiles(config.AppEnv)

	config.AppName = env.GetString("APP_NAME", "mote")
	config.AppVersion = env.GetString("APP_VERSION", "1.0.0")

	config.PostsPerPage = env.GetInt("POSTS_PER_PAGE", 20)

	config.StaticURL = env.GetString("STATIC_URL", "/static")
	// If StaticPath is not set, then static files will be served from embedded FS
	config.StaticPath = env.GetString("STATIC_PATH", "")

	config.HTTP = HTTPConfig{
		IP:           env.GetString("HTTP_IP", "127.0.0.1"),
		Port:         env.GetInt("HTTP_PORT", 8000),
		MaxBodySize:  env.GetByteSize("HTTP_MAX_BODY_SIZE", 1024*1024*10),
		ReadTimeout:  env.GetDuration("HTTP_READ_TIMEOUT", 10*time.Second),
		WriteTimeout: env.GetDuration("HTTP_WRITE_TIMEOUT", 10*time.Second),
		IdleTimeout:  env.GetDuration("HTTP_IDLE_TIMEOUT", 30*time.Second),
		CORS: CORSConfig{
			AllowedOrigins:   env.GetSlice("CORS_ALLOWED_ORIGINS", []string{}),
			AllowedMethods:   env.GetSlice("CORS_ALLOWED_METHODS", []string{}),
			AllowedHeaders:   env.GetSlice("CORS_ALLOWED_HEADERS", []string{}),
			AllowCredentials: env.GetBool("CORS_ALLOW_CREDENTIALS", false),
			MaxAge:           env.GetInt("CORS_MAX_AGE", 3600*24),
		},
	}

	config.Upload = UploadConfig{
		BaseURL:             env.GetString("UPLOAD_URL", "/uploads"),
		BasePath:            env.GetString("UPLOAD_PATH", "./uploads"),
		AccelRedirectPrefix: env.GetString("DRIVE_ACCEL_REDIRECT_PREFIX", ""),
		ImageFormats:        env.GetSlice("UPLOAD_IMAGE_FORMATS", []string{"jpg", "jpeg", "png", "webp", "gif"}),
		ThumbWidth:          uint32(env.GetInt("UPLOAD_THUMB_WIDTH", 128)),
	}

	config.DB = DBConfig{
		URL:         env.GetString("DATABASE_URL", "app.db"),
		PoolSize:    env.GetInt("DATABASE_POOL_SIZE", 5),
		AutoMigrate: env.GetBool("DATABASE_AUTO_MIGRATE", true),
	}

	config.Redis = RedisConfig{
		URL:      env.GetString("REDIS_URL", "localhost:6379"),
		Password: env.GetString("REDIS_PASSWORD", ""),
		DB:       env.GetInt("REDIS_DB", 0),
	}

	config.Log = LogConfig{
		LogRequests: env.GetBool("LOG_REQUESTS", true),
	}

	config.validate()

	return config
}

// ToJSON returns the configuration as a JSON string, optionally hiding sensitive information
func (c *Config) ToJSON(hideSensitive bool) (string, error) {
	// Create a copy to avoid exposing sensitive info
	safe := *c

	if hideSensitive {
		safe.DB.URL = maskSensitive(safe.DB.URL)
		safe.Redis.URL = maskSensitive(safe.Redis.URL)
		safe.Redis.Password = maskSecret(safe.Redis.Password)
	}

	data, err := json.MarshalIndent(safe, "", "  ")
	if err != nil {
		return "", fmt.Errorf("failed to marshal config to JSON: %w", err)
	}

	return string(data), nil
}

// ValidateConfig validates the configuration and panics if any validation fails
func (c *Config) validate() {
	var errs []string

	// Validate basic app info
	if c.AppName == "" {
		errs = append(errs, "AppName cannot be empty")
	}
	if c.AppVersion == "" {
		errs = append(errs, "AppVersion cannot be empty")
	}
	if c.AppEnv == "" {
		errs = append(errs, "AppEnv cannot be empty")
	}

	if c.AppEnv != "development" && c.AppEnv != "dev" && c.AppEnv != "production" && c.AppEnv != "prod" && c.AppEnv != "test" {
		errs = append(errs, fmt.Sprintf("AppEnv must be one of 'development', 'dev', 'production', 'prod', or 'test', got '%s'", c.AppEnv))
	}

	// Validate application settings
	if c.PostsPerPage <= 0 {
		errs = append(errs, "PostsPerPage must be greater than 0")
	}
	if c.PostsPerPage > 1000 {
		errs = append(errs, "PostsPerPage cannot exceed 1000")
	}
	if c.StaticURL == "" {
		errs = append(errs, "StaticURL cannot be empty")
	}

	// Validate HTTP config
	if c.HTTP.IP == "" {
		errs = append(errs, "HTTP.IP cannot be empty")
	} else if ip := net.ParseIP(c.HTTP.IP); ip == nil {
		errs = append(errs, fmt.Sprintf("HTTP.IP '%s' is not a valid IP address", c.HTTP.IP))
	}

	if c.HTTP.Port <= 0 || c.HTTP.Port > 65535 {
		errs = append(errs, fmt.Sprintf("HTTP.Port must be between 1 and 65535, got %d", c.HTTP.Port))
	}

	if c.HTTP.MaxBodySize <= 0 {
		errs = append(errs, "HTTP.MaxBodySize must be greater than 0")
	}
	if c.HTTP.ReadTimeout <= 0 {
		errs = append(errs, "HTTP.ReadTimeout must be greater than 0")
	}
	if c.HTTP.WriteTimeout <= 0 {
		errs = append(errs, "HTTP.WriteTimeout must be greater than 0")
	}
	if c.HTTP.IdleTimeout <= 0 {
		errs = append(errs, "HTTP.IdleTimeout must be greater than 0")
	}

	// Validate CORS config
	if c.HTTP.CORS.MaxAge < 0 {
		errs = append(errs, "CORS.MaxAge cannot be negative")
	}

	// Validate Upload config
	if c.Upload.BaseURL == "" {
		errs = append(errs, "Upload.BaseURL cannot be empty")
	}
	if c.Upload.AccelRedirectPrefix != "" && !strings.HasPrefix(c.Upload.AccelRedirectPrefix, "/") {
		errs = append(errs, "Upload.AccelRedirectPrefix must start with '/'")
	}
	if c.Upload.BasePath == "" {
		errs = append(errs, "Upload.BasePath cannot be empty")
	} else {
		// Ensure upload directory exists or can be created
		if err := os.MkdirAll(c.Upload.BasePath, 0755); err != nil {
			errs = append(errs, fmt.Sprintf("failed to create upload directory '%s': %v", c.Upload.BasePath, err))
		} else {
			// Check if directory is writable
			testFile := filepath.Join(c.Upload.BasePath, ".write_test")
			if err := os.WriteFile(testFile, []byte("test"), 0644); err != nil {
				errs = append(errs, fmt.Sprintf("upload directory '%s' is not writable: %v", c.Upload.BasePath, err))
			} else {
				os.Remove(testFile)
			}
		}
	}

	if len(c.Upload.ImageFormats) == 0 {
		errs = append(errs, "Upload.ImageFormats cannot be empty")
	} else {
		validFormats := map[string]bool{"jpg": true, "jpeg": true, "png": true, "webp": true, "gif": true}
		for _, format := range c.Upload.ImageFormats {
			if !validFormats[strings.ToLower(format)] {
				errs = append(errs, fmt.Sprintf("invalid image format: %s", format))
			}
		}
	}

	if c.Upload.ThumbWidth == 0 {
		errs = append(errs, "Upload.ThumbWidth must be greater than 0")
	}
	if c.Upload.ThumbWidth > 4096 {
		errs = append(errs, "Upload.ThumbWidth cannot exceed 4096")
	}

	// Validate DB config
	if c.DB.URL == "" {
		errs = append(errs, "DB.URL cannot be empty")
	}
	if c.DB.PoolSize <= 0 {
		errs = append(errs, "DB.PoolSize must be greater than 0")
	}
	if c.DB.PoolSize > 1000 {
		errs = append(errs, "DB.PoolSize cannot exceed 1000")
	}

	// Validate Redis config
	if c.Redis.URL == "" {
		errs = append(errs, "Redis.URL cannot be empty")
	}
	if c.Redis.DB < 0 {
		errs = append(errs, "Redis.DB cannot be negative")
	}
	if c.Redis.DB > 15 {
		errs = append(errs, "Redis.DB cannot exceed 15")
	}

	// If there are validation errors, panic with all of them
	if len(errs) > 0 {
		panic(fmt.Sprintf("configuration validation failed:\n  - %s", strings.Join(errs, "\n  - ")))
	}
}

// maskSensitive masks sensitive information in URLs
func maskSensitive(url string) string {
	// Check if it contains "://"
	if strings.Contains(url, "://") {
		parts := strings.Split(url, "://")
		if len(parts) == 2 {
			scheme := parts[0]
			rest := parts[1]

			// Look for user info part
			if atIndex := strings.Index(rest, "@"); atIndex != -1 {
				userInfo := rest[:atIndex]
				hostPath := rest[atIndex:]

				// Mask password part
				if colonIndex := strings.Index(userInfo, ":"); colonIndex != -1 {
					username := userInfo[:colonIndex]
					return fmt.Sprintf("%s://%s:***%s", scheme, username, hostPath)
				}
			}
		}
	}
	return url
}

// maskSecret masks a secret string, showing only the first and last 4 characters
func maskSecret(secret string) string {
	if secret == "" {
		return ""
	}
	if len(secret) <= 8 {
		return "***"
	}
	return secret[:4] + "***" + secret[len(secret)-4:]
}
