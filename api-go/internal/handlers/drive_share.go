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
	"net/url"
	"strconv"
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
	r.Get("/{token}/zip", h.Zip)
	r.Get("/{token}/thumb", h.Thumb)
}

func (h *DriveShareHandler) Landing(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	share, node, err := h.share.Resolve(r.Context(), token)
	if err != nil {
		writeShareErr(w, err)
		return
	}

	authed := h.passwordOK(r, share, token)

	if node.Type == "folder" {
		h.folderLanding(w, r, share, node, token, authed)
		return
	}

	if strings.Contains(r.Header.Get("Accept"), "application/json") {
		writeJSON(w, http.StatusOK, map[string]any{
			"name":         node.Name,
			"size":         node.Size.Int64,
			"type":         node.Type,
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

// folderLanding renders the visitor page for a shared folder: a server-side
// file listing with breadcrumbs scoped to the share root, per-file
// download/preview links, image thumbnails, and a zip-all button. Navigation
// inside the share uses ?dir=<id>; every id is validated as an active
// descendant of the share root (ResolveChild).
func (h *DriveShareHandler) folderLanding(
	w http.ResponseWriter, r *http.Request,
	share *models.DriveShare, root *models.DriveNode, token string, authed bool,
) {
	ctx := r.Context()

	display := root
	// Only honour ?dir= once unlocked — a locked share reveals nothing but its name.
	if dirStr := r.URL.Query().Get("dir"); dirStr != "" && authed {
		dirID, _ := strconv.ParseInt(dirStr, 10, 64)
		if dirID <= 0 {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		n, err := h.share.ResolveChild(ctx, root.ID, dirID)
		if err != nil {
			writeShareErr(w, err)
			return
		}
		if n.Type != "folder" {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		display = n
	}

	var children []models.DriveNode
	var crumbs []models.DriveBreadcrumb
	if authed {
		var err error
		children, err = h.drive.List(ctx, &display.ID, nil, "name", "asc")
		if err != nil {
			log.Printf("share folder list: %v", err)
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		crumbs, err = h.drive.Breadcrumbs(ctx, display.ID)
		if err != nil {
			log.Printf("share folder breadcrumbs: %v", err)
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		// Scope the chain to the share root — never leak ancestors above it.
		for i, bc := range crumbs {
			if bc.ID == root.ID {
				crumbs = crumbs[i:]
				break
			}
		}
	}

	if strings.Contains(r.Header.Get("Accept"), "application/json") {
		resp := map[string]any{
			"name":         root.Name,
			"size":         int64(0),
			"type":         root.Type,
			"mime_type":    "",
			"has_password": share.HasPassword,
			"authed":       authed,
			"expires_at":   nullable(share.ExpiresAt),
		}
		if authed {
			resp["dir"] = map[string]any{"id": display.ID, "name": display.Name}
			bcs := make([]map[string]any, 0, len(crumbs))
			for _, bc := range crumbs {
				bcs = append(bcs, map[string]any{"id": bc.ID, "name": bc.Name})
			}
			resp["breadcrumbs"] = bcs
			kids := make([]map[string]any, 0, len(children))
			for i := range children {
				c := &children[i]
				kids = append(kids, map[string]any{
					"id":        c.ID,
					"name":      c.Name,
					"type":      c.Type,
					"size":      c.Size.Int64,
					"mime_type": c.MimeType(),
				})
			}
			resp["children"] = kids
		}
		writeJSON(w, http.StatusOK, resp)
		return
	}

	type crumbVM struct {
		ID             int64
		Name           string
		IsRoot, IsLast bool
	}
	type childVM struct {
		ID         int64
		Name       string
		Size       string
		IsFolder   bool
		IsImage    bool
		CanPreview bool
	}

	crumbVMs := make([]crumbVM, 0, len(crumbs))
	for i, bc := range crumbs {
		crumbVMs = append(crumbVMs, crumbVM{
			ID:     bc.ID,
			Name:   bc.Name,
			IsRoot: i == 0,
			IsLast: i == len(crumbs)-1,
		})
	}
	childVMs := make([]childVM, 0, len(children))
	for i := range children {
		c := &children[i]
		vm := childVM{ID: c.ID, Name: c.Name, IsFolder: c.Type == "folder", Size: "—"}
		if !vm.IsFolder {
			vm.Size = humanSize(c.Size.Int64)
			mt := c.MimeType()
			vm.IsImage = strings.HasPrefix(mt, "image/")
			// Anything safe to serve inline opens in a browser tab; the rest
			// links straight to download.
			vm.CanPreview = !mustForceAttachment(mt, c.Ext())
		}
		childVMs = append(childVMs, vm)
	}
	var dirID int64
	if display.ID != root.ID {
		dirID = display.ID
	}

	tmpl, _ := template.New("folder-share").Parse(folderLandingHTML)
	_ = tmpl.Execute(w, map[string]any{
		"RootName":    root.Name,
		"HasPassword": share.HasPassword,
		"Authed":      authed,
		"Token":       token,
		"Crumbs":      crumbVMs,
		"Children":    childVMs,
		"DirID":       dirID,
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
	// Folder shares address their files via ?id= (validated as an active
	// descendant of the share root). A bare folder root has no blob to serve.
	target := node
	if idStr := r.URL.Query().Get("id"); idStr != "" {
		id, _ := strconv.ParseInt(idStr, 10, 64)
		if id <= 0 {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		target, err = h.share.ResolveChild(r.Context(), node.ID, id)
		if err != nil {
			writeShareErr(w, err)
			return
		}
	}
	if target.Type != "file" || !target.BlobPath.Valid {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	// Shares are accessed by third parties — keep HTML as attachment to avoid XSS.
	serveStoredDriveBlob(w, r, h.drive, target, forceAttachment, false)
}

// Zip streams the shared folder (or a ?dir= subfolder of it) as a zip archive.
func (h *DriveShareHandler) Zip(w http.ResponseWriter, r *http.Request) {
	// Zip generation + streaming can be slow for large folders.
	http.NewResponseController(w).SetWriteDeadline(time.Now().Add(2 * time.Hour))

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
	target := node
	if dirStr := r.URL.Query().Get("dir"); dirStr != "" {
		dirID, _ := strconv.ParseInt(dirStr, 10, 64)
		if dirID <= 0 {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		target, err = h.share.ResolveChild(r.Context(), node.ID, dirID)
		if err != nil {
			writeShareErr(w, err)
			return
		}
	}
	if target.Type != "folder" {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition",
		fmt.Sprintf("attachment; filename*=UTF-8''%s.zip", url.PathEscape(target.Name)))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if err := h.drive.ZipFolder(r.Context(), target.ID, w); err != nil {
		log.Printf("share zip failed: %v", err)
	}
}

// Thumb serves an image thumbnail for a file inside a shared folder. Reuses
// the lazily-generated disk cache from the authenticated thumb endpoint.
func (h *DriveShareHandler) Thumb(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	share, node, err := h.share.Resolve(r.Context(), token)
	if err != nil {
		writeShareErr(w, err)
		return
	}
	// Plain 401 (not a redirect): the consumer is an <img>, not a navigation.
	if share.HasPassword && !h.passwordOK(r, share, token) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	idStr := r.URL.Query().Get("id")
	id, _ := strconv.ParseInt(idStr, 10, 64)
	if id <= 0 {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if _, err := h.share.ResolveChild(r.Context(), node.ID, id); err != nil {
		writeShareErr(w, err)
		return
	}
	path, err := h.drive.Thumbnail(r.Context(), id)
	if err != nil {
		if errors.Is(err, services.ErrDriveNotFound) || errors.Is(err, services.ErrDriveNotImage) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		log.Printf("share thumb: %v", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	serveThumbFile(w, r, path)
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

// folderLandingHTML is the visitor page for shared folders: breadcrumbs
// scoped to the share root, a child listing with thumbnails for images, and
// per-file preview/download links. Kept as a plain server-rendered page (no
// JS) in the same style as the single-file landing above.
const folderLandingHTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{.RootName}} · Mote Drive</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         display:flex; align-items:flex-start; justify-content:center; min-height:100vh;
         background:#fafafa; margin:0; padding:32px 16px; box-sizing:border-box; color:#1a1a1a; }
  .card { background:#fff; padding:24px 28px; border-radius:14px; box-shadow:0 4px 24px rgba(0,0,0,.06);
          max-width:720px; width:100%; box-sizing:border-box; }
  h1 { font-size:18px; margin:0 0 4px; word-break:break-all; }
  p.size { color:#888; margin:0 0 24px; font-size:13px; }
  .crumbs { font-size:14px; margin:0 0 14px; color:#888; word-break:break-all; }
  .crumbs a { color:#2563eb; text-decoration:none; }
  .crumbs a:hover { text-decoration:underline; }
  .crumbs .sep { margin:0 6px; color:#ccc; }
  .crumbs .cur { color:#1a1a1a; font-weight:500; }
  ul.rows { list-style:none; margin:0 0 20px; padding:0; border-top:1px solid #f0f0f0; }
  li.row { display:flex; align-items:center; gap:12px; padding:9px 4px; border-bottom:1px solid #f0f0f0; }
  li.row:hover { background:#fafafa; }
  .glyph { width:36px; height:36px; display:flex; align-items:center; justify-content:center;
           background:#f5f5f5; border-radius:8px; flex-shrink:0; }
  img.thumb { width:36px; height:36px; object-fit:cover; border-radius:8px; flex-shrink:0; background:#f5f5f5; }
  a.name { flex:1; min-width:0; color:#1a1a1a; text-decoration:none; font-size:14px;
           overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  a.name:hover { color:#2563eb; }
  .sz { color:#999; font-size:12px; flex-shrink:0; min-width:64px; text-align:right; }
  a.dl { display:flex; padding:6px; border-radius:6px; color:#666; flex-shrink:0; }
  a.dl:hover { background:#eee; color:#1a1a1a; }
  .actions { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
  a.btn, button { display:inline-block; padding:10px 18px; border-radius:8px; background:#111;
           color:#fff; text-decoration:none; border:0; cursor:pointer; font-size:14px; }
  input[type=password] { width:100%; padding:10px 12px; border:1px solid #ddd; border-radius:8px;
           font-size:14px; box-sizing:border-box; margin-bottom:12px; }
  form { margin-top:8px; }
  .empty { color:#999; font-size:14px; padding:24px 0; text-align:center; }
  .meta { color:#666; font-size:13px; margin-top:18px; }
</style>
</head>
<body>
  <div class="card">
    {{if and .HasPassword (not .Authed)}}
      <h1>{{.RootName}}</h1>
      <p class="size">Folder</p>
      <form method="post" action="/shared-files/{{.Token}}/auth">
        <input type="password" name="password" placeholder="Password" autofocus required />
        <button type="submit">Unlock</button>
      </form>
    {{else}}
      <nav class="crumbs">{{range $i, $c := .Crumbs}}{{if $i}}<span class="sep">/</span>{{end}}{{if $c.IsLast}}<span class="cur">{{$c.Name}}</span>{{else if $c.IsRoot}}<a href="/shared-files/{{$.Token}}">{{$c.Name}}</a>{{else}}<a href="/shared-files/{{$.Token}}?dir={{$c.ID}}">{{$c.Name}}</a>{{end}}{{end}}</nav>
      {{if .Children}}
      <ul class="rows">
        {{range .Children}}
        <li class="row">
          {{if .IsImage}}
            <img class="thumb" loading="lazy" src="/shared-files/{{$.Token}}/thumb?id={{.ID}}" onerror="this.style.display='none'" alt="" />
          {{else if .IsFolder}}
            <span class="glyph"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d99c2b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></span>
          {{else}}
            <span class="glyph"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#8a8f98" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></span>
          {{end}}
          {{if .IsFolder}}
            <a class="name" href="/shared-files/{{$.Token}}?dir={{.ID}}">{{.Name}}</a>
          {{else if .CanPreview}}
            <a class="name" href="/shared-files/{{$.Token}}/preview?id={{.ID}}" target="_blank" rel="noopener">{{.Name}}</a>
          {{else}}
            <a class="name" href="/shared-files/{{$.Token}}/download?id={{.ID}}">{{.Name}}</a>
          {{end}}
          <span class="sz">{{.Size}}</span>
          {{if not .IsFolder}}
          <a class="dl" href="/shared-files/{{$.Token}}/download?id={{.ID}}" title="Download"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></a>
          {{end}}
        </li>
        {{end}}
      </ul>
      {{else}}
      <p class="empty">This folder is empty</p>
      {{end}}
      <div class="actions">
        <a class="btn" href="/shared-files/{{.Token}}/zip{{if .DirID}}?dir={{.DirID}}{{end}}">Download all (.zip)</a>
      </div>
    {{end}}
    <p class="meta">Shared via Mote Drive</p>
  </div>
</body>
</html>`
