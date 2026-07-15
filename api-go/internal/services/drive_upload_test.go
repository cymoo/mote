package services

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cymoo/mote/internal/config"
	"github.com/cymoo/mote/internal/models"
	"github.com/jmoiron/sqlx"
)

// setupDriveFullDB creates the full drive schema (nodes + uploads + shares) and
// returns the DB plus the three drive services.
func setupDriveFullDB(t *testing.T) (*sqlx.DB, *DriveService, *DriveUploadService, *DriveShareService) {
	t.Helper()
	dsn := "file:" + t.Name() + "?mode=memory&cache=shared&_pragma=foreign_keys(1)"
	db, err := sqlx.Open("sqlite", dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })

	schema := `
CREATE TABLE drive_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER REFERENCES drive_nodes(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('folder','file')),
  name TEXT NOT NULL,
  blob_path TEXT,
  size INTEGER,
  hash TEXT,
  starred_at INTEGER,
  deleted_at INTEGER,
  delete_batch_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX drive_nodes_unique_active
  ON drive_nodes(COALESCE(parent_id, 0), LOWER(name))
  WHERE deleted_at IS NULL;

CREATE TABLE drive_uploads (
  id TEXT PRIMARY KEY,
  parent_id INTEGER,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  chunk_size INTEGER NOT NULL,
  total_chunks INTEGER NOT NULL,
  received_mask BLOB NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('uploading','assembling','done','failed')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE drive_shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER NOT NULL REFERENCES drive_nodes(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  token TEXT,
  password_hash TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX drive_shares_prefix ON drive_shares(token_prefix);
`
	if _, err := db.Exec(schema); err != nil {
		t.Fatalf("schema: %v", err)
	}

	tmp := t.TempDir()
	cfg := &config.UploadConfig{BaseURL: "/uploads", BasePath: tmp}
	drive := NewDriveService(db, cfg)
	upload := NewDriveUploadService(db, drive, cfg)
	share := NewDriveShareService(db, drive)
	return db, drive, upload, share
}

// performUpload runs init -> chunk(s) -> complete and returns the resulting node.
func performUpload(
	t *testing.T,
	upload *DriveUploadService,
	parentID *int64,
	name string,
	content []byte,
	chunkSize int64,
	onCollision string,
) *models.DriveNode {
	t.Helper()
	ctx := context.Background()
	u, err := upload.Init(ctx, models.DriveUploadInitRequest{
		ParentID:  parentID,
		Name:      name,
		Size:      int64(len(content)),
		ChunkSize: chunkSize,
	})
	if err != nil {
		t.Fatalf("init: %v", err)
	}
	for i := 0; i < u.TotalChunks; i++ {
		start := int64(i) * chunkSize
		end := start + chunkSize
		if end > int64(len(content)) {
			end = int64(len(content))
		}
		if err := upload.PutChunk(ctx, u.ID, i, bytes.NewReader(content[start:end])); err != nil {
			t.Fatalf("put chunk %d: %v", i, err)
		}
	}
	node, err := upload.Complete(ctx, u.ID, onCollision)
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	return node
}

// ---- upload tests ----

func TestUpload_SingleChunkRoundTrip(t *testing.T) {
	_, _, upload, _ := setupDriveFullDB(t)
	body := []byte("hello, drive!")
	node := performUpload(t, upload, nil, "hello.txt", body, 1<<20, "ask")

	if node.Type != "file" || node.Name != "hello.txt" {
		t.Fatalf("bad node: %+v", node)
	}
	if !node.Size.Valid || node.Size.Int64 != int64(len(body)) {
		t.Fatalf("size: %+v", node.Size)
	}
	if !node.Hash.Valid || len(node.Hash.String) != 64 {
		t.Fatalf("hash: %+v", node.Hash)
	}

	// Blob should exist on disk.
	if !node.BlobPath.Valid {
		t.Fatal("blob path missing")
	}
	abs := upload.config.BasePath + string(filepath.Separator) + node.BlobPath.String
	got, err := os.ReadFile(abs)
	if err != nil {
		t.Fatalf("read blob: %v", err)
	}
	if !bytes.Equal(got, body) {
		t.Fatalf("blob mismatch")
	}
}

func TestUpload_MultiChunkAssembly(t *testing.T) {
	_, _, upload, _ := setupDriveFullDB(t)
	// 5MB content, 1MB chunks.
	body := bytes.Repeat([]byte("ABCDE"), 1<<20)
	node := performUpload(t, upload, nil, "big.bin", body, 1<<20, "ask")

	if node.Size.Int64 != int64(len(body)) {
		t.Fatalf("size mismatch: %d", node.Size.Int64)
	}
	abs := filepath.Join(upload.config.BasePath, node.BlobPath.String)
	got, _ := os.ReadFile(abs)
	if !bytes.Equal(got, body) {
		t.Fatalf("assembled blob mismatch")
	}
}

func TestUpload_IdempotentChunkPut(t *testing.T) {
	_, _, upload, _ := setupDriveFullDB(t)
	ctx := context.Background()
	body := []byte("idempotent!")
	u, err := upload.Init(ctx, models.DriveUploadInitRequest{Name: "x.txt", Size: int64(len(body)), ChunkSize: 1 << 20})
	if err != nil {
		t.Fatalf("init: %v", err)
	}
	// Put same chunk twice — should not error.
	for i := 0; i < 2; i++ {
		if err := upload.PutChunk(ctx, u.ID, 0, bytes.NewReader(body)); err != nil {
			t.Fatalf("put #%d: %v", i, err)
		}
	}
	if _, err := upload.Complete(ctx, u.ID, "ask"); err != nil {
		t.Fatalf("complete: %v", err)
	}
}

func TestUpload_CompleteIncomplete(t *testing.T) {
	_, _, upload, _ := setupDriveFullDB(t)
	ctx := context.Background()
	// Two chunks but we only upload one.
	body := bytes.Repeat([]byte("x"), int(1<<20)+1)
	u, err := upload.Init(ctx, models.DriveUploadInitRequest{Name: "x.bin", Size: int64(len(body)), ChunkSize: 1 << 20})
	if err != nil {
		t.Fatalf("init: %v", err)
	}
	if err := upload.PutChunk(ctx, u.ID, 0, bytes.NewReader(body[:1<<20])); err != nil {
		t.Fatalf("put: %v", err)
	}
	if _, err := upload.Complete(ctx, u.ID, "ask"); !errors.Is(err, ErrUploadIncomplete) {
		t.Fatalf("expected ErrUploadIncomplete, got %v", err)
	}
}

func TestUpload_TooLarge(t *testing.T) {
	_, _, upload, _ := setupDriveFullDB(t)
	_, err := upload.Init(context.Background(), models.DriveUploadInitRequest{
		Name: "big", Size: maxFileSize + 1, ChunkSize: 1 << 20,
	})
	if !errors.Is(err, ErrUploadTooLarge) {
		t.Fatalf("expected ErrUploadTooLarge, got %v", err)
	}
}

func TestUpload_CollisionAsk(t *testing.T) {
	_, _, upload, _ := setupDriveFullDB(t)
	performUpload(t, upload, nil, "dup.txt", []byte("first"), 1<<20, "ask")
	// Second upload with same name and on_collision="ask" should be rejected.
	ctx := context.Background()
	body := []byte("second")
	u, _ := upload.Init(ctx, models.DriveUploadInitRequest{Name: "dup.txt", Size: int64(len(body)), ChunkSize: 1 << 20})
	if err := upload.PutChunk(ctx, u.ID, 0, bytes.NewReader(body)); err != nil {
		t.Fatalf("put: %v", err)
	}
	if _, err := upload.Complete(ctx, u.ID, "ask"); !errors.Is(err, ErrDriveNameConflict) {
		t.Fatalf("expected name conflict, got %v", err)
	}
}

func TestUpload_CollisionRename(t *testing.T) {
	_, _, upload, _ := setupDriveFullDB(t)
	performUpload(t, upload, nil, "dup.txt", []byte("first"), 1<<20, "ask")
	n2 := performUpload(t, upload, nil, "dup.txt", []byte("second"), 1<<20, "rename")
	if n2.Name == "dup.txt" {
		t.Fatalf("expected renamed, got %s", n2.Name)
	}
	if !strings.HasPrefix(n2.Name, "dup") {
		t.Fatalf("rename should keep stem: %s", n2.Name)
	}
}

func TestUpload_CollisionOverwrite(t *testing.T) {
	_, _, upload, _ := setupDriveFullDB(t)
	first := performUpload(t, upload, nil, "dup.txt", []byte("first"), 1<<20, "ask")
	second := performUpload(t, upload, nil, "dup.txt", []byte("the second one"), 1<<20, "overwrite")

	if second.ID == first.ID {
		// overwrite reuses the same logical name but should be a fresh file row OR
		// updated row — the contract is "the visible name is taken by the new file".
		// Either way, the resolved file content must be the new one.
	}
	abs := filepath.Join(upload.config.BasePath, second.BlobPath.String)
	got, _ := os.ReadFile(abs)
	if string(got) != "the second one" {
		t.Fatalf("overwrite content: %s", got)
	}
}

func TestUpload_Cancel(t *testing.T) {
	_, _, upload, _ := setupDriveFullDB(t)
	ctx := context.Background()
	u, err := upload.Init(ctx, models.DriveUploadInitRequest{Name: "x", Size: 100, ChunkSize: 1 << 20})
	if err != nil {
		t.Fatalf("init: %v", err)
	}
	if err := upload.Cancel(ctx, u.ID); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if _, _, err := upload.Get(ctx, u.ID); !errors.Is(err, ErrUploadNotFound) {
		t.Fatalf("expected not-found after cancel, got %v", err)
	}
}

// ---- share tests ----

func makeFileNode(t *testing.T, upload *DriveUploadService) *models.DriveNode {
	t.Helper()
	return performUpload(t, upload, nil, "share-me.txt", []byte("payload"), 1<<20, "ask")
}

func TestShare_CreateAndResolve(t *testing.T) {
	_, _, upload, share := setupDriveFullDB(t)
	ctx := context.Background()
	node := makeFileNode(t, upload)

	sh, err := share.Create(ctx, node.ID, nil, nil)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if sh.Token == "" {
		t.Fatal("token not returned")
	}
	if !sh.StoredToken.Valid || sh.StoredToken.String != sh.Token {
		t.Fatal("token should be stored for owner-visible share links")
	}
	if sh.HasPassword {
		t.Fatal("should not require password")
	}

	got, gotNode, err := share.Resolve(ctx, sh.Token)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got.ID != sh.ID || gotNode.ID != node.ID {
		t.Fatalf("resolve mismatch")
	}
}

func TestShare_BadToken(t *testing.T) {
	_, _, _, share := setupDriveFullDB(t)
	if _, _, err := share.Resolve(context.Background(), "deadbeef-not-real"); !errors.Is(err, ErrShareNotFound) {
		t.Fatalf("expected ErrShareNotFound, got %v", err)
	}
}

func TestShare_FolderCreateAndResolve(t *testing.T) {
	_, drive, _, share := setupDriveFullDB(t)
	ctx := context.Background()
	folder, err := drive.CreateFolder(ctx, nil, "Pics")
	if err != nil {
		t.Fatalf("folder: %v", err)
	}
	sh, err := share.Create(ctx, folder.ID, nil, nil)
	if err != nil {
		t.Fatalf("folder share create: %v", err)
	}
	_, node, err := share.Resolve(ctx, sh.Token)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if node.ID != folder.ID || node.Type != "folder" {
		t.Fatalf("resolved node: %+v", node)
	}
}

// ResolveChild gates every ?id=/?dir= on the public folder-share surface:
// only the share root itself and its ACTIVE descendants may resolve.
func TestShare_ResolveChildScope(t *testing.T) {
	_, drive, upload, share := setupDriveFullDB(t)
	ctx := context.Background()

	root, _ := drive.CreateFolder(ctx, nil, "root")
	sub, _ := drive.CreateFolder(ctx, &root.ID, "sub")
	inner := performUpload(t, upload, &sub.ID, "in.txt", []byte("in"), 1<<20, "ask")
	outside := performUpload(t, upload, nil, "out.txt", []byte("out"), 1<<20, "ask")

	// The root itself resolves.
	if n, err := share.ResolveChild(ctx, root.ID, root.ID); err != nil || n.ID != root.ID {
		t.Fatalf("root self: %v", err)
	}
	// An active descendant resolves.
	if n, err := share.ResolveChild(ctx, root.ID, inner.ID); err != nil || n.ID != inner.ID {
		t.Fatalf("descendant: %v", err)
	}
	// A node outside the share subtree → not found.
	if _, err := share.ResolveChild(ctx, root.ID, outside.ID); !errors.Is(err, ErrShareNotFound) {
		t.Fatalf("outside: %v", err)
	}
	// A trashed descendant → not found.
	if err := drive.SoftDelete(ctx, []int64{inner.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := share.ResolveChild(ctx, root.ID, inner.ID); !errors.Is(err, ErrShareNotFound) {
		t.Fatalf("trashed child: %v", err)
	}
	// A child inside a trashed folder → not found (the deleted hop breaks the chain).
	f2, _ := drive.CreateFolder(ctx, &root.ID, "f2")
	leaf := performUpload(t, upload, &f2.ID, "leaf.txt", []byte("leaf"), 1<<20, "ask")
	if err := drive.SoftDelete(ctx, []int64{f2.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := share.ResolveChild(ctx, root.ID, leaf.ID); !errors.Is(err, ErrShareNotFound) {
		t.Fatalf("child of trashed folder: %v", err)
	}
}

func TestShare_Password(t *testing.T) {
	_, _, upload, share := setupDriveFullDB(t)
	ctx := context.Background()
	node := makeFileNode(t, upload)

	pw := "secret123"
	sh, err := share.Create(ctx, node.ID, &pw, nil)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if !sh.HasPassword {
		t.Fatal("expected password flag")
	}
	if err := share.VerifyPassword(sh, "wrong"); !errors.Is(err, ErrShareWrongPassword) {
		t.Fatalf("wrong password should fail, got %v", err)
	}
	if err := share.VerifyPassword(sh, pw); err != nil {
		t.Fatalf("correct password rejected: %v", err)
	}
}

func TestShare_Expired(t *testing.T) {
	_, _, upload, share := setupDriveFullDB(t)
	ctx := context.Background()
	node := makeFileNode(t, upload)

	past := int64(1) // long ago in epoch-ms
	sh, err := share.Create(ctx, node.ID, nil, &past)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	_, _, err = share.Resolve(ctx, sh.Token)
	if !errors.Is(err, ErrShareExpired) {
		t.Fatalf("expected ErrShareExpired, got %v", err)
	}
}

func TestShare_Revoke(t *testing.T) {
	_, _, upload, share := setupDriveFullDB(t)
	ctx := context.Background()
	node := makeFileNode(t, upload)
	sh, err := share.Create(ctx, node.ID, nil, nil)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := share.Revoke(ctx, sh.ID); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if _, _, err := share.Resolve(ctx, sh.Token); !errors.Is(err, ErrShareNotFound) {
		t.Fatalf("expected ErrShareNotFound after revoke, got %v", err)
	}
}

func TestShare_ListByNode(t *testing.T) {
	_, _, upload, share := setupDriveFullDB(t)
	ctx := context.Background()
	node := makeFileNode(t, upload)
	if _, err := share.Create(ctx, node.ID, nil, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := share.Create(ctx, node.ID, nil, nil); err != nil {
		t.Fatal(err)
	}
	list, err := share.ListByNode(ctx, node.ID)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("expected 2 shares, got %d", len(list))
	}
	for _, s := range list {
		if s.Token != "" {
			t.Fatal("token must not leak from ListByNode")
		}
	}
}

// Two uploads with identical content must share one blob on disk.
func TestUpload_DedupReusesBlob(t *testing.T) {
	_, drive, upload, _ := setupDriveFullDB(t)
	body := []byte("identical bytes")

	n1 := performUpload(t, upload, nil, "one.txt", body, 1<<20, "ask")
	n2 := performUpload(t, upload, nil, "two.txt", body, 1<<20, "ask")

	if !n2.BlobPath.Valid || n2.BlobPath.String != n1.BlobPath.String {
		t.Fatalf("expected shared blob, got %q vs %q", n1.BlobPath.String, n2.BlobPath.String)
	}
	// Exactly one blob file in drive/ (chunks/thumbs live in subdirectories).
	entries, err := os.ReadDir(filepath.Join(drive.config.BasePath, "drive"))
	if err != nil {
		t.Fatal(err)
	}
	var files int
	for _, e := range entries {
		if !e.IsDir() {
			files++
		}
	}
	if files != 1 {
		t.Fatalf("expected 1 blob file, got %d", files)
	}
}

// Dedup must skip candidates whose blob no longer exists on disk.
func TestUpload_DedupSkipsMissingBlobOnDisk(t *testing.T) {
	_, drive, upload, _ := setupDriveFullDB(t)
	body := []byte("payload to lose")

	n1 := performUpload(t, upload, nil, "one.txt", body, 1<<20, "ask")
	// Simulate external deletion of the stored blob.
	if err := os.Remove(drive.BlobAbsPath(n1.BlobPath.String)); err != nil {
		t.Fatal(err)
	}

	n2 := performUpload(t, upload, nil, "two.txt", body, 1<<20, "ask")
	if n2.BlobPath.String == n1.BlobPath.String {
		t.Fatalf("must not reuse a missing blob")
	}
	if _, err := os.Stat(drive.BlobAbsPath(n2.BlobPath.String)); err != nil {
		t.Fatalf("fresh blob missing: %v", err)
	}
}

// Overwriting a file with identical content dedups against the very blob being
// replaced and must not delete it.
func TestUpload_DedupOverwriteSameContent(t *testing.T) {
	_, drive, upload, _ := setupDriveFullDB(t)
	body := []byte("same content twice")

	n1 := performUpload(t, upload, nil, "dup.txt", body, 1<<20, "ask")
	n2 := performUpload(t, upload, nil, "dup.txt", body, 1<<20, "overwrite")

	if n2.BlobPath.String != n1.BlobPath.String {
		t.Fatalf("expected overwrite to reuse the identical blob, got %q vs %q",
			n2.BlobPath.String, n1.BlobPath.String)
	}
	got, err := os.ReadFile(drive.BlobAbsPath(n2.BlobPath.String))
	if err != nil {
		t.Fatalf("blob gone after self-overwrite: %v", err)
	}
	if !bytes.Equal(got, body) {
		t.Fatal("content mismatch after overwrite")
	}
}

// Complete must re-validate the parent folder; if it was soft-deleted between
// Init and Complete, we should refuse rather than orphan the file.
func TestUpload_CompleteRefusesDeletedParent(t *testing.T) {
	_, drive, upload, _ := setupDriveFullDB(t)
	ctx := context.Background()
	parent, _ := drive.CreateFolder(ctx, nil, "p")

	body := []byte("payload")
	u, err := upload.Init(ctx, models.DriveUploadInitRequest{
		ParentID: &parent.ID, Name: "x.txt", Size: int64(len(body)), ChunkSize: 1 << 20,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := upload.PutChunk(ctx, u.ID, 0, bytes.NewReader(body)); err != nil {
		t.Fatal(err)
	}
	// Soft-delete the parent before completing.
	if err := drive.SoftDelete(ctx, []int64{parent.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := upload.Complete(ctx, u.ID, "ask"); !errors.Is(err, ErrDriveNotFound) {
		t.Fatalf("expected ErrDriveNotFound, got %v", err)
	}
}

// Concurrent chunk uploads of the same session must not deadlock with
// SQLITE_BUSY. The test uses real disk + real connection pool to expose
// the deferred-tx upgrade hazard fixed by BEGIN IMMEDIATE in PutChunk.
func TestUpload_ConcurrentChunksNoBusy(t *testing.T) {
	t.Helper()
	dsn := "file:" + t.Name() + "?mode=memory&cache=shared&_pragma=foreign_keys(1)&_pragma=busy_timeout(2000)&_pragma=journal_mode(WAL)"
	db, err := sqlx.Open("sqlite", dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	db.SetMaxOpenConns(8)

	schema := `
CREATE TABLE drive_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER REFERENCES drive_nodes(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  blob_path TEXT, size INTEGER, hash TEXT, starred_at INTEGER,
  deleted_at INTEGER, delete_batch_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX drive_nodes_unique_active
  ON drive_nodes(COALESCE(parent_id, 0), LOWER(name)) WHERE deleted_at IS NULL;
CREATE TABLE drive_uploads (
  id TEXT PRIMARY KEY, parent_id INTEGER, name TEXT NOT NULL,
  size INTEGER NOT NULL, chunk_size INTEGER NOT NULL, total_chunks INTEGER NOT NULL,
  received_mask BLOB NOT NULL, status TEXT NOT NULL,
  expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE drive_shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER NOT NULL REFERENCES drive_nodes(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE, token_prefix TEXT NOT NULL,
  token TEXT, password_hash TEXT, expires_at INTEGER, created_at INTEGER NOT NULL
);`
	if _, err := db.Exec(schema); err != nil {
		t.Fatalf("schema: %v", err)
	}
	tmp := t.TempDir()
	cfg := &config.UploadConfig{BaseURL: "/uploads", BasePath: tmp}
	drive := NewDriveService(db, cfg)
	upload := NewDriveUploadService(db, drive, cfg)

	ctx := context.Background()
	const chunk = int64(1 << 20)
	const n = 16
	body := bytes.Repeat([]byte{'x'}, int(chunk)*n)
	u, err := upload.Init(ctx, models.DriveUploadInitRequest{
		Name: "concur.bin", Size: int64(len(body)), ChunkSize: chunk,
	})
	if err != nil {
		t.Fatal(err)
	}

	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		i := i
		go func() {
			start := int64(i) * chunk
			end := start + chunk
			errs <- upload.PutChunk(ctx, u.ID, i, bytes.NewReader(body[start:end]))
		}()
	}
	for i := 0; i < n; i++ {
		if err := <-errs; err != nil {
			t.Fatalf("chunk %d: %v", i, err)
		}
	}
	// After all chunks land, complete should succeed.
	if _, err := upload.Complete(ctx, u.ID, "ask"); err != nil {
		t.Fatalf("complete: %v", err)
	}
	_ = strings.ToUpper
}
