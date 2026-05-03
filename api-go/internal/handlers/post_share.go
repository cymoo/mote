package handlers

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"html/template"
	"io/fs"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"github.com/cymoo/mote/internal/models"
	"github.com/cymoo/mote/pkg/util/env"
	"github.com/go-chi/chi/v5"
	"github.com/jmoiron/sqlx"
)

var (
	// regex patterns to extract header and bold paragraph
	headerAndBoldParagraphPattern = regexp.MustCompile(`<h[1-3][^>]*>(.*?)</h[1-3]>\s*(?:<p[^>]*><strong>(.*?)</strong></p>)?`)
	// regex pattern to remove strong tags
	strongTagPattern = regexp.MustCompile(`</?strong>`)
)

// PostMetaData represents post metadata for list view
type PostMetaData struct {
	ID          int64  `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description"`
	CreatedAt   string `json:"created_at"`
}

type PostPageHandler struct {
	db        *sqlx.DB
	templates map[string]*template.Template
}

// NewPostPageHandler creates a new PostHandler
func NewPostPageHandler(db *sqlx.DB, templateFS fs.FS) (*PostPageHandler, error) {
	templates := make(map[string]*template.Template)

	// safe function to prevent HTML escaping
	funcMap := template.FuncMap{
		"safe": func(s string) template.HTML {
			return template.HTML(s)
		},
	}

	// Define pages and their associated template files
	pages := map[string][]string{
		"post-list": {"templates/layout.tpl", "templates/post-list.tpl"},
		"post-item": {"templates/layout.tpl", "templates/post-item.tpl"},
		"error":     {"templates/error.tpl"},
	}

	// Parse templates for each page
	for pageName, files := range pages {
		tmpl, err := template.New("").Funcs(funcMap).ParseFS(templateFS, files...)
		if err != nil {
			return nil, fmt.Errorf("parsing templates for %s: %w", pageName, err)
		}
		templates[pageName] = tmpl
	}

	return &PostPageHandler{
		db:        db,
		templates: templates,
	}, nil
}

// PostList handles the post list page
func (h *PostPageHandler) PostList(w http.ResponseWriter, r *http.Request) {
	var posts []models.Post
	query := `
		SELECT * FROM posts
		WHERE shared = 1 AND deleted_at IS NULL
		ORDER BY created_at DESC
	`

	// Fetch posts from the database
	err := h.db.Select(&posts, query)
	if err != nil {
		h.render500(w, err)
		return
	}

	// Extract metadata for each post
	result := make([]PostMetaData, 0, len(posts))
	for _, post := range posts {
		title, description := extractHeaderAndDescriptionFromHTML(post.Content)
		result = append(result, PostMetaData{
			ID:          post.ID,
			Title:       title,
			Description: description,
			CreatedAt:   timestampToLocalDate(post.CreatedAt / 1000),
		})
	}

	aboutURL := env.GetString("ABOUT_URL", "")

	data := map[string]any{
		"about_url": aboutURL,
		"posts":     result,
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := h.templates["post-list"].ExecuteTemplate(w, "layout", data); err != nil {
		h.render500(w, err)
	}
}

// PostItem handles the individual post page
func (h *PostPageHandler) PostItem(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")

	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		h.render404(w)
		return
	}

	var post models.Post
	query := `
		SELECT * FROM posts
		WHERE id = ? AND deleted_at IS NULL AND shared = 1
	`
	// Fetch the post from the database
	err = h.db.Get(&post, query, id)
	if err != nil {
		if err == sql.ErrNoRows {
			h.render404(w)
			return
		}
		h.render500(w, err)
		return
	}

	// Extract title from post content
	title, _ := extractHeaderAndDescriptionFromHTML(post.Content)

	var images []models.FileInfo
	if post.Files.Valid && len(post.Files.RawMessage) > 0 {
		if err := json.Unmarshal(post.Files.RawMessage, &images); err != nil {
			log.Printf("failed to unmarshal files for post %d: %v", post.ID, err)
		}
	}

	aboutURL := env.GetString("ABOUT_URL", "")

	titleStr := title
	if titleStr == "" {
		titleStr = "mote"
	}

	data := map[string]any{
		"about_url": aboutURL,
		"post":      post,
		"title":     titleStr,
		"images":    images,
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := h.templates["post-item"].ExecuteTemplate(w, "layout", data); err != nil {
		h.render500(w, err)
	}
}

// render404 renders the 404 page
func (h *PostPageHandler) render404(w http.ResponseWriter) {
	data := map[string]any{
		"code":    404,
		"error":   "Page Not Found",
		"message": "The page does not exist. Please check if the URL is correct.",
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(404)
	if err := h.templates["error"].ExecuteTemplate(w, "error", data); err != nil {
		http.Error(w, "Not Found", 404)
	}
}

// render500 renders the 500 page
func (h *PostPageHandler) render500(w http.ResponseWriter, err error) {
	log.Printf("Error: %v", err)
	data := map[string]any{
		"code":    500,
		"error":   "Internal Server Error",
		"message": "An unexpected error occurred. Please try again later.",
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(500)
	if err := h.templates["error"].ExecuteTemplate(w, "error", data); err != nil {
		http.Error(w, "Internal Server Error", 500)
	}
}

// extractHeaderAndDescriptionFromHTML extracts title and description from HTML
func extractHeaderAndDescriptionFromHTML(html string) (string, string) {
	matches := headerAndBoldParagraphPattern.FindStringSubmatch(html)
	if len(matches) < 2 {
		return "", ""
	}

	title := matches[1]
	var description string

	if len(matches) > 2 && matches[2] != "" {
		description = strongTagPattern.ReplaceAllString(matches[2], "")
	}

	return title, description
}

// timestampToLocalDate converts Unix timestamp to local date string
func timestampToLocalDate(timestamp int64) string {
	t := time.Unix(timestamp, 0)
	return t.Format("2006-01-02")
}
