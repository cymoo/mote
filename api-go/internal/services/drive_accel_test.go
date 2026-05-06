package services

import (
	"path/filepath"
	"testing"

	"github.com/cymoo/mote/internal/config"
)

func TestBlobAccelRedirectURI(t *testing.T) {
	drive := NewDriveService(nil, &config.UploadConfig{
		BasePath:            t.TempDir(),
		AccelRedirectPrefix: "/__mote_drive_blobs__/",
	})

	got, enabled, err := drive.BlobAccelRedirectURI(filepath.Join("drive", "video name.mp4"))
	if err != nil {
		t.Fatalf("redirect uri: %v", err)
	}
	if !enabled {
		t.Fatal("expected acceleration to be enabled")
	}
	want := "/__mote_drive_blobs__/video%20name.mp4"
	if got != want {
		t.Fatalf("redirect uri = %q, want %q", got, want)
	}
}

func TestBlobAccelRedirectURIDisabled(t *testing.T) {
	drive := NewDriveService(nil, &config.UploadConfig{BasePath: t.TempDir()})

	got, enabled, err := drive.BlobAccelRedirectURI("drive/video.mp4")
	if err != nil {
		t.Fatalf("redirect uri: %v", err)
	}
	if enabled || got != "" {
		t.Fatalf("got uri=%q enabled=%v, want disabled empty uri", got, enabled)
	}
}

func TestBlobAccelRedirectURIRejectsUnsafePaths(t *testing.T) {
	drive := NewDriveService(nil, &config.UploadConfig{
		BasePath:            t.TempDir(),
		AccelRedirectPrefix: "/__mote_drive_blobs__",
	})

	for _, rel := range []string{
		"/tmp/video.mp4",
		"../drive/video.mp4",
		"drive/_chunks/session/0.bin",
		"drive/nested/video.mp4",
		"other/video.mp4",
	} {
		t.Run(rel, func(t *testing.T) {
			if uri, enabled, err := drive.BlobAccelRedirectURI(rel); err == nil || !enabled || uri != "" {
				t.Fatalf("BlobAccelRedirectURI(%q) = uri %q enabled %v err %v, want enabled error", rel, uri, enabled, err)
			}
		})
	}
}
