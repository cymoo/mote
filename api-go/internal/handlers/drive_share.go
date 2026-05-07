package handlers

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/cymoo/mote/internal/models"
	"github.com/cymoo/mote/internal/services"
	"github.com/go-chi/chi/v5"
	"github.com/redis/go-redis/v9"
)

const sharePasswordCookiePrefix = "drive_share_pw_"

// DriveShareHandler serves the public, anonymous share endpoints under /shared-files/*.
type DriveShareHandler struct {
	drive *services.DriveService
	share *services.DriveShareService
	redis *redis.Client
}

func NewDriveShareHandler(
	drive *services.DriveService,
	share *services.DriveShareService,
	r *redis.Client,
) *DriveShareHandler {
	return &DriveShareHandler{drive: drive, share: share, redis: r}
}

// Routes attaches the public share endpoints. Mount this OUTSIDE auth middleware.
func (h *DriveShareHandler) Routes(r chi.Router) {
	r.Get("/{token}", h.Landing)
	r.Post("/{token}/auth", h.Auth)
	r.Get("/{token}/download", h.Download)
	r.Get("/{token}/preview", h.Preview)
}

func (h *DriveShareHandler) Landing(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	share, node, err := h.share.Resolve(r.Context(), token)
	if err != nil {
		writeShareErr(w, err)
		return
	}

	authed := h.passwordOK(r, share, token)

	if strings.Contains(r.Header.Get("Accept"), "application/json") {
		writeJSON(w, http.StatusOK, map[string]any{
			"name":         node.Name,
			"size":         node.Size.Int64,
			"mime_type":    node.MimeType(),
			"has_password": share.HasPassword,
			"authed":       authed,
			"expires_at":   nullable(share.ExpiresAt),
		})
		return
	}

	tmpl, _ := template.New("share").Parse(landingHTML)
	mimeType := node.MimeType()
	_ = tmpl.Execute(w, map[string]any{
		"Name":        node.Name,
		"Size":        humanSize(node.Size.Int64),
		"HasPassword": share.HasPassword,
		"Authed":      authed,
		"Token":       token,
		"MimeType":    mimeType,
		"CanVideo":    strings.HasPrefix(mimeType, "video/"),
		"CanAudio":    strings.HasPrefix(mimeType, "audio/"),
	})
}

func (h *DriveShareHandler) Auth(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	if !h.rateLimit(r.Context(), token, clientIP(r)) {
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}
	share, _, err := h.share.Resolve(r.Context(), token)
	if err != nil {
		writeShareErr(w, err)
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	pw := r.FormValue("password")
	if err := h.share.VerifyPassword(share, pw); err != nil {
		writeShareErr(w, err)
		return
	}
	cookieValue, ok := sharePasswordCookieValue(share, token)
	if !ok {
		writeShareErr(w, services.ErrShareNoPassword)
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     sharePasswordCookieName(token),
		Value:    cookieValue,
		Path:     "/shared-files/" + token,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   60 * 60 * 24,
	})
	http.Redirect(w, r, "/shared-files/"+token, http.StatusSeeOther)
}

func (h *DriveShareHandler) Download(w http.ResponseWriter, r *http.Request) {
	h.serveShared(w, r, true)
}

func (h *DriveShareHandler) Preview(w http.ResponseWriter, r *http.Request) {
	h.serveShared(w, r, false)
}

func (h *DriveShareHandler) serveShared(w http.ResponseWriter, r *http.Request, forceAttachment bool) {
	// Extend write deadline so large shared-file downloads aren't cut off by
	// the global WriteTimeout.
	http.NewResponseController(w).SetWriteDeadline(time.Now().Add(time.Hour))

	token := chi.URLParam(r, "token")
	share, node, err := h.share.Resolve(r.Context(), token)
	if err != nil {
		writeShareErr(w, err)
		return
	}
	if share.HasPassword && !h.passwordOK(r, share, token) {
		http.Redirect(w, r, "/shared-files/"+token, http.StatusSeeOther)
		return
	}
	if !node.BlobPath.Valid {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	serveStoredDriveBlob(w, r, h.drive, node, forceAttachment)
}

func (h *DriveShareHandler) passwordOK(r *http.Request, share *models.DriveShare, token string) bool {
	if !share.HasPassword {
		return true
	}
	c, err := r.Cookie(sharePasswordCookieName(token))
	if err != nil {
		return false
	}
	want, ok := sharePasswordCookieValue(share, token)
	return ok && subtle.ConstantTimeCompare([]byte(c.Value), []byte(want)) == 1
}

// rateLimit allows up to 10 attempts per 5 minutes per (token, IP).
func (h *DriveShareHandler) rateLimit(ctx context.Context, token, ip string) bool {
	if h.redis == nil {
		return true
	}
	key := fmt.Sprintf("drive:share:rl:%s:%s", token, ip)
	pipe := h.redis.TxPipeline()
	incr := pipe.Incr(ctx, key)
	pipe.Expire(ctx, key, 5*time.Minute)
	if _, err := pipe.Exec(ctx); err != nil {
		log.Printf("share rate limit check failed: %v", err)
		return true
	}
	return incr.Val() <= 10
}

func sharePasswordCookieName(token string) string {
	// Cookie names cannot contain certain chars; token is URL-safe base64.
	return sharePasswordCookiePrefix + strings.NewReplacer("-", "_").Replace(token[:min(8, len(token))])
}

func sharePasswordCookieValue(share *models.DriveShare, token string) (string, bool) {
	if !share.PasswordHash.Valid {
		return "", false
	}
	mac := hmac.New(sha256.New, []byte(share.PasswordHash.String))
	_, _ = mac.Write([]byte(token))
	return hex.EncodeToString(mac.Sum(nil)), true
}

func writeShareErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, services.ErrShareNotFound), errors.Is(err, services.ErrDriveNotFound):
		http.Error(w, "not found", http.StatusNotFound)
	case errors.Is(err, services.ErrShareExpired):
		http.Error(w, "share expired", http.StatusGone)
	case errors.Is(err, services.ErrShareWrongPassword):
		http.Error(w, "wrong password", http.StatusUnauthorized)
	case errors.Is(err, services.ErrShareNoPassword):
		http.Error(w, "no password", http.StatusBadRequest)
	default:
		log.Printf("share serve error: %v", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
	}
}

func clientIP(r *http.Request) string {
	if v := r.Header.Get("X-Forwarded-For"); v != "" {
		if i := strings.Index(v, ","); i >= 0 {
			return strings.TrimSpace(v[:i])
		}
		return strings.TrimSpace(v)
	}
	if v := r.Header.Get("X-Real-IP"); v != "" {
		return v
	}
	if i := strings.LastIndex(r.RemoteAddr, ":"); i >= 0 {
		return r.RemoteAddr[:i]
	}
	return r.RemoteAddr
}

func nullable(n models.NullInt64) *int64 {
	if !n.Valid {
		return nil
	}
	v := n.Int64
	return &v
}

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}

func humanSize(n int64) string {
	const k = 1024
	if n < k {
		return fmt.Sprintf("%d B", n)
	}
	units := []string{"KB", "MB", "GB", "TB"}
	v := float64(n) / k
	u := 0
	for v >= k && u < len(units)-1 {
		v /= k
		u++
	}
	return fmt.Sprintf("%.1f %s", v, units[u])
}

const landingHTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{.Name}} · Mote Drive</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         display:flex; align-items:center; justify-content:center; min-height:100vh;
         background:#fafafa; margin:0; color:#1a1a1a; }
  .card { background:#fff; padding:32px 36px; border-radius:14px; box-shadow:0 4px 24px rgba(0,0,0,.06);
          max-width:420px; width:100%; }
  h1 { font-size:18px; margin:0 0 4px; word-break:break-all; }
  p.size { color:#888; margin:0 0 24px; font-size:13px; }
  a.btn, button { display:inline-block; padding:10px 18px; border-radius:8px; background:#111;
           color:#fff; text-decoration:none; border:0; cursor:pointer; font-size:14px; }
  .actions { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
  .preview { display:block; width:100%; max-height:60vh; margin:0 0 16px; border-radius:10px; background:#000; }
  audio.preview { background:transparent; }
  input[type=password] { width:100%; padding:10px 12px; border:1px solid #ddd; border-radius:8px;
           font-size:14px; box-sizing:border-box; margin-bottom:12px; }
  form { margin-top:8px; }
  .meta { color:#666; font-size:13px; margin-top:18px; }
</style>
</head>
<body>
  <div class="card">
    <h1>{{.Name}}</h1>
    <p class="size">{{.Size}}</p>
    {{if and .HasPassword (not .Authed)}}
      <form method="post" action="/shared-files/{{.Token}}/auth">
        <input type="password" name="password" placeholder="Password" autofocus required />
        <button type="submit">Unlock</button>
      </form>
    {{else}}
      {{if .CanVideo}}
        <video class="preview" src="/shared-files/{{.Token}}/preview" controls preload="metadata"></video>
      {{else if .CanAudio}}
        <audio class="preview" src="/shared-files/{{.Token}}/preview" controls preload="metadata"></audio>
      {{end}}
      <div class="actions">
        <a class="btn" href="/shared-files/{{.Token}}/download">Download</a>
      </div>
    {{end}}
    <p class="meta">Shared via Mote Drive</p>
  </div>
</body>
</html>`
