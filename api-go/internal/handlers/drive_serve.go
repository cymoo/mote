package handlers

import (
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"time"

	"github.com/cymoo/mote/internal/models"
	"github.com/cymoo/mote/internal/services"
)

func serveStoredDriveBlob(
	w http.ResponseWriter,
	r *http.Request,
	drive *services.DriveService,
	node *models.DriveNode,
	forceAttachment bool,
	allowInlineHTML bool,
) {
	if node.Type != "file" || !node.BlobPath.Valid || node.DeletedAt.Valid {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	accelURI, accelEnabled, err := drive.BlobAccelRedirectURI(node.BlobPath.String)
	if err != nil {
		log.Printf("drive accel redirect refused blob path %q: %v", node.BlobPath.String, err)
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	abs := drive.BlobAbsPath(node.BlobPath.String)
	st, err := os.Stat(abs)
	if err != nil || st.IsDir() {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	disp := "inline"
	if forceAttachment || mustForceAttachment(node.MimeType(), node.Ext()) {
		disp = "attachment"
	}
	// Authenticated-user preview of HTML: allow inline rendering so the iframe
	// can display the document. mustForceAttachment blocks HTML by default to
	// prevent XSS when files are served directly, but inside our iframe the
	// user is intentionally viewing their own file.
	if allowInlineHTML && isHTMLContent(node.MimeType(), node.Ext()) {
		disp = "inline"
	}
	w.Header().Set("Content-Type", node.MimeType())
	w.Header().Set("Content-Disposition",
		fmt.Sprintf("%s; filename*=UTF-8''%s", disp, url.PathEscape(node.Name)))
	w.Header().Set("X-Content-Type-Options", "nosniff")

	if accelEnabled {
		w.Header().Set("X-Accel-Redirect", accelURI)
		return
	}

	f, err := os.Open(abs)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	defer f.Close()
	http.ServeContent(w, r, node.Name, time.UnixMilli(node.UpdatedAt), f)
}

// serveThumbFile streams a cached thumbnail JPEG from disk. Shared by the
// authenticated /api/drive/thumb and the public /shared-files/{token}/thumb.
func serveThumbFile(w http.ResponseWriter, r *http.Request, path string) {
	f, err := os.Open(path)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "private, max-age=86400")
	http.ServeContent(w, r, "thumb.jpg", st.ModTime(), f)
}
