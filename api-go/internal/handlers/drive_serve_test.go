package handlers

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cymoo/mote/internal/config"
	"github.com/cymoo/mote/internal/models"
	"github.com/cymoo/mote/internal/services"
)

func testDriveNode(name, blobPath string) *models.DriveNode {
	return &models.DriveNode{
		Type:      "file",
		Name:      name,
		BlobPath:  models.NullString{NullString: sql.NullString{String: blobPath, Valid: true}},
		UpdatedAt: time.Now().UnixMilli(),
	}
}

func TestServeStoredDriveBlobFallbackSupportsRange(t *testing.T) {
	tmp := t.TempDir()
	blob := filepath.Join("drive", "video.mp4")
	abs := filepath.Join(tmp, blob)
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(abs, []byte("0123456789"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	drive := services.NewDriveService(nil, &config.UploadConfig{BasePath: tmp})

	req := httptest.NewRequest(http.MethodGet, "/api/drive/preview?id=1", nil)
	req.Header.Set("Range", "bytes=2-5")
	rec := httptest.NewRecorder()
	serveStoredDriveBlob(rec, req, drive, testDriveNode("video.mp4", blob), false)

	if rec.Code != http.StatusPartialContent {
		t.Fatalf("status = %d, want %d; body %q", rec.Code, http.StatusPartialContent, rec.Body.String())
	}
	if got := rec.Body.String(); got != "2345" {
		t.Fatalf("body = %q, want %q", got, "2345")
	}
	if got := rec.Header().Get("Content-Range"); got != "bytes 2-5/10" {
		t.Fatalf("Content-Range = %q, want bytes 2-5/10", got)
	}
}

func TestServeStoredDriveBlobAccelRedirect(t *testing.T) {
	tmp := t.TempDir()
	blob := filepath.Join("drive", "video name.mp4")
	abs := filepath.Join(tmp, blob)
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(abs, []byte("video"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	drive := services.NewDriveService(nil, &config.UploadConfig{
		BasePath:            tmp,
		AccelRedirectPrefix: "/__mote_drive_blobs__",
	})

	req := httptest.NewRequest(http.MethodGet, "/api/drive/preview?id=1", nil)
	rec := httptest.NewRecorder()
	serveStoredDriveBlob(rec, req, drive, testDriveNode("video name.mp4", blob), false)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body %q", rec.Code, http.StatusOK, rec.Body.String())
	}
	if got := rec.Header().Get("X-Accel-Redirect"); got != "/__mote_drive_blobs__/video%20name.mp4" {
		t.Fatalf("X-Accel-Redirect = %q", got)
	}
	if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "video/mp4") {
		t.Fatalf("Content-Type = %q, want video/mp4", got)
	}
	if got := rec.Header().Get("Content-Disposition"); !strings.HasPrefix(got, "inline;") {
		t.Fatalf("Content-Disposition = %q, want inline", got)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("body length = %d, want 0", rec.Body.Len())
	}
}

func TestServeStoredDriveBlobAccelRejectsUnsafePath(t *testing.T) {
	tmp := t.TempDir()
	drive := services.NewDriveService(nil, &config.UploadConfig{
		BasePath:            tmp,
		AccelRedirectPrefix: "/__mote_drive_blobs__",
	})
	blob := filepath.Join("drive", "_chunks", "video.mp4")
	abs := filepath.Join(tmp, blob)
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(abs, []byte("video"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/drive/preview?id=1", nil)
	rec := httptest.NewRecorder()
	serveStoredDriveBlob(rec, req, drive, testDriveNode("video.mp4", blob), false)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusNotFound)
	}
	if got := rec.Header().Get("X-Accel-Redirect"); got != "" {
		t.Fatalf("X-Accel-Redirect = %q, want empty", got)
	}
}
