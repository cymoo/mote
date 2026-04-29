package services

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

func mustImageFile(t *testing.T, d *DriveService, parent *int64, name string, w, h int) int64 {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for x := 0; x < w; x++ {
		for y := 0; y < h; y++ {
			img.Set(x, y, color.RGBA{uint8(x), uint8(y), 200, 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode: %v", err)
	}
	blobRel := "test_thumb_" + name
	abs := d.BlobAbsPath(blobRel)
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(abs, buf.Bytes(), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	n, err := d.CreateFileNode(context.Background(), parent, name, blobRel, "", int64(buf.Len()))
	if err != nil {
		t.Fatalf("create file: %v", err)
	}
	return n.ID
}

func TestThumbnail_GeneratesAndCaches(t *testing.T) {
	_, drive, _, _ := setupDriveFullDB(t)
	ctx := context.Background()

	id := mustImageFile(t, drive, nil, "pic.png", 800, 600)

	path1, err := drive.Thumbnail(ctx, id)
	if err != nil {
		t.Fatalf("thumbnail: %v", err)
	}
	st1, err := os.Stat(path1)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if st1.Size() == 0 {
		t.Fatal("empty thumb")
	}

	// Second call should return the same cached file.
	path2, err := drive.Thumbnail(ctx, id)
	if err != nil {
		t.Fatalf("thumbnail2: %v", err)
	}
	if path1 != path2 {
		t.Fatalf("path mismatch: %s vs %s", path1, path2)
	}

	// Verify it's a valid image of expected width.
	f, _ := os.Open(path1)
	defer f.Close()
	img, _, err := image.Decode(f)
	if err != nil {
		t.Fatalf("decode thumb: %v", err)
	}
	if img.Bounds().Dx() != thumbWidth {
		t.Fatalf("expected width %d, got %d", thumbWidth, img.Bounds().Dx())
	}
}

func TestThumbnail_NonImageReturnsErr(t *testing.T) {
	_, drive, _, _ := setupDriveFullDB(t)
	id := mustFileReturnID(t, drive, nil, "doc.txt", []byte("hello"))
	if _, err := drive.Thumbnail(context.Background(), id); err == nil {
		t.Fatal("expected error for non-image")
	}
}

func mustFileReturnID(t *testing.T, d *DriveService, parent *int64, name string, body []byte) int64 {
	t.Helper()
	blobRel := "test_nonimg_" + name
	abs := d.BlobAbsPath(blobRel)
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(abs, body, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	n, err := d.CreateFileNode(context.Background(), parent, name, blobRel, "", int64(len(body)))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	return n.ID
}
