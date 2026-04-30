package services

import (
	"archive/zip"
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"
)

// TestZipFolder_RoundTrip ensures the streaming zip output is a valid archive
// and contains all descendants with correct relative paths and bytes.
func TestZipFolder_RoundTrip(t *testing.T) {
	_, drive, _, _ := setupDriveFullDB(t)
	ctx := context.Background()

	root, err := drive.CreateFolder(ctx, nil, "root")
	if err != nil {
		t.Fatalf("root: %v", err)
	}
	sub, err := drive.CreateFolder(ctx, &root.ID, "sub")
	if err != nil {
		t.Fatalf("sub: %v", err)
	}
	deep, err := drive.CreateFolder(ctx, &sub.ID, "deep")
	if err != nil {
		t.Fatalf("deep: %v", err)
	}

	mustFile(t, drive, &root.ID, "a.txt", []byte("hello"))
	mustFile(t, drive, &sub.ID, "b.txt", []byte("world"))
	mustFile(t, drive, &deep.ID, "c.bin", []byte{1, 2, 3})

	var buf bytes.Buffer
	if err := drive.ZipFolder(ctx, root.ID, &buf); err != nil {
		t.Fatalf("zip: %v", err)
	}

	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatalf("invalid zip: %v (size=%d)", err, buf.Len())
	}

	got := map[string]string{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("open %s: %v", f.Name, err)
		}
		b, _ := io.ReadAll(rc)
		rc.Close()
		got[f.Name] = string(b)
	}

	want := map[string]string{
		"a.txt":          "hello",
		"sub/":           "",
		"sub/b.txt":      "world",
		"sub/deep/":      "",
		"sub/deep/c.bin": string([]byte{1, 2, 3}),
	}
	for k, v := range want {
		gv, ok := got[k]
		if !ok {
			t.Errorf("missing entry %q in zip; got entries: %v", k, mapKeys(got))
			continue
		}
		if gv != v {
			t.Errorf("entry %q: got %q, want %q", k, gv, v)
		}
	}
}

func mapKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func mustFile(t *testing.T, d *DriveService, parent *int64, name string, body []byte) {
	t.Helper()
	ctx := context.Background()
	blobRel := "test_" + name
	abs := d.BlobAbsPath(blobRel)
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(abs, body, 0o644); err != nil {
		t.Fatalf("write blob: %v", err)
	}
	if _, err := d.CreateFileNode(ctx, parent, name, blobRel, "", int64(len(body))); err != nil {
		t.Fatalf("create file %s: %v", name, err)
	}
}
