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

// mustFileNode is mustFile with a distinct blob name + returned node, for
// tests that need unique content per node.
func mustFileNode(t *testing.T, d *DriveService, parent *int64, name, blobRel string, body []byte) int64 {
	t.Helper()
	ctx := context.Background()
	abs := d.BlobAbsPath(blobRel)
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(abs, body, 0o644); err != nil {
		t.Fatalf("write blob: %v", err)
	}
	n, err := d.CreateFileNode(ctx, parent, name, blobRel, "", int64(len(body)))
	if err != nil {
		t.Fatalf("create file %s: %v", name, err)
	}
	return n.ID
}

func readZip(t *testing.T, buf *bytes.Buffer) map[string]string {
	t.Helper()
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
	return got
}

// ZipNodes: a mixed folder + file selection lands as top-level entries, with
// the folder keeping its own name as the top-level directory.
func TestZipNodes_MixedSelection(t *testing.T) {
	_, drive, _, _ := setupDriveFullDB(t)
	ctx := context.Background()

	folder, _ := drive.CreateFolder(ctx, nil, "photos")
	mustFile(t, drive, &folder.ID, "a.jpg", []byte("aaa"))
	rootFile := mustFileNode(t, drive, nil, "notes.txt", "test_notes.bin", []byte("nnn"))

	var buf bytes.Buffer
	if err := drive.ZipNodes(ctx, []int64{folder.ID, rootFile}, &buf); err != nil {
		t.Fatalf("zip: %v", err)
	}
	got := readZip(t, &buf)

	want := map[string]string{
		"photos/":      "",
		"photos/a.jpg": "aaa",
		"notes.txt":    "nnn",
	}
	for k, v := range want {
		if gv, ok := got[k]; !ok || gv != v {
			t.Errorf("entry %q = %q/%v, want %q; all: %v", k, gv, ok, v, mapKeys(got))
		}
	}
	if len(got) != len(want) {
		t.Errorf("entries = %d, want %d: %v", len(got), len(want), mapKeys(got))
	}
}

// ZipNodes: ids nested under other selected folders are skipped, not doubled.
func TestZipNodes_SkipsNestedSelection(t *testing.T) {
	_, drive, _, _ := setupDriveFullDB(t)
	ctx := context.Background()

	outer, _ := drive.CreateFolder(ctx, nil, "outer")
	inner, _ := drive.CreateFolder(ctx, &outer.ID, "inner")
	nestedFile := mustFileNode(t, drive, &inner.ID, "deep.txt", "test_deep.bin", []byte("ddd"))

	var buf bytes.Buffer
	if err := drive.ZipNodes(ctx, []int64{outer.ID, inner.ID, nestedFile}, &buf); err != nil {
		t.Fatalf("zip: %v", err)
	}
	got := readZip(t, &buf)

	want := map[string]string{
		"outer/":               "",
		"outer/inner/":         "",
		"outer/inner/deep.txt": "ddd",
	}
	if len(got) != len(want) {
		t.Fatalf("entries = %v, want exactly %v", mapKeys(got), mapKeys(want))
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("entry %q = %q, want %q", k, got[k], v)
		}
	}
}

// ZipNodes: same-named top-level picks (possible from search-result
// selections) get suffixed instead of silently dropped.
func TestZipNodes_DuplicateTopLevelSuffixed(t *testing.T) {
	_, drive, _, _ := setupDriveFullDB(t)
	ctx := context.Background()

	f1, _ := drive.CreateFolder(ctx, nil, "one")
	f2, _ := drive.CreateFolder(ctx, nil, "two")
	a := mustFileNode(t, drive, &f1.ID, "dup.txt", "test_dup_a.bin", []byte("first"))
	b := mustFileNode(t, drive, &f2.ID, "dup.txt", "test_dup_b.bin", []byte("second"))

	var buf bytes.Buffer
	if err := drive.ZipNodes(ctx, []int64{a, b}, &buf); err != nil {
		t.Fatalf("zip: %v", err)
	}
	got := readZip(t, &buf)

	if got["dup.txt"] != "first" || got["dup (1).txt"] != "second" {
		t.Fatalf("entries = %v", got)
	}
}
