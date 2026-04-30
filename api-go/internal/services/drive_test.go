package services

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/cymoo/mote/internal/config"
	"github.com/cymoo/mote/internal/models"
	"github.com/jmoiron/sqlx"
	_ "modernc.org/sqlite"
)

func setupDriveDB(t *testing.T) (*sqlx.DB, *DriveService) {
	t.Helper()
	dsn := "file:" + t.Name() + "?mode=memory&cache=shared&_pragma=foreign_keys(1)"
	db, err := sqlx.Open("sqlite", dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })

	schema := `
CREATE TABLE drive_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER REFERENCES drive_nodes(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('folder','file')),
  name TEXT NOT NULL,
  blob_path TEXT,
  size INTEGER,
  hash TEXT,
  deleted_at INTEGER,
  delete_batch_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX drive_nodes_unique_active
  ON drive_nodes(COALESCE(parent_id, 0), LOWER(name))
  WHERE deleted_at IS NULL;
CREATE INDEX drive_nodes_parent ON drive_nodes(parent_id, deleted_at);
CREATE TABLE drive_shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER NOT NULL REFERENCES drive_nodes(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  password_hash TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX drive_shares_node ON drive_shares(node_id);
`
	if _, err := db.Exec(schema); err != nil {
		t.Fatalf("schema: %v", err)
	}

	tmp := t.TempDir()
	cfg := &config.UploadConfig{BaseURL: "/uploads", BasePath: tmp}
	svc := NewDriveService(db, cfg)
	return db, svc
}

func TestDrive_CreateAndListFolder(t *testing.T) {
	_, svc := setupDriveDB(t)
	ctx := context.Background()

	root, err := svc.CreateFolder(ctx, nil, "Photos")
	if err != nil {
		t.Fatalf("create root: %v", err)
	}
	if root.Type != "folder" || root.Name != "Photos" {
		t.Fatalf("unexpected: %+v", root)
	}

	if _, err := svc.CreateFolder(ctx, &root.ID, "2024"); err != nil {
		t.Fatalf("create child: %v", err)
	}

	rows, err := svc.List(ctx, &root.ID, nil, "name", "asc")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(rows) != 1 || rows[0].Name != "2024" {
		t.Fatalf("listing wrong: %+v", rows)
	}
}

func TestDrive_NameCollision(t *testing.T) {
	_, svc := setupDriveDB(t)
	ctx := context.Background()
	if _, err := svc.CreateFolder(ctx, nil, "docs"); err != nil {
		t.Fatal(err)
	}
	_, err := svc.CreateFolder(ctx, nil, "Docs") // case-insensitive
	if !errors.Is(err, ErrDriveNameConflict) {
		t.Fatalf("expected ErrDriveNameConflict, got %v", err)
	}
}

func TestDrive_MoveCycleRejected(t *testing.T) {
	_, svc := setupDriveDB(t)
	ctx := context.Background()
	a, _ := svc.CreateFolder(ctx, nil, "a")
	b, _ := svc.CreateFolder(ctx, &a.ID, "b")
	c, _ := svc.CreateFolder(ctx, &b.ID, "c")

	// Move a into c → cycle.
	err := svc.Move(ctx, []int64{a.ID}, &c.ID)
	if !errors.Is(err, ErrDriveCycle) {
		t.Fatalf("expected cycle error, got %v", err)
	}

	// Move a into a → cycle.
	err = svc.Move(ctx, []int64{a.ID}, &a.ID)
	if !errors.Is(err, ErrDriveCycle) {
		t.Fatalf("expected cycle error self, got %v", err)
	}
}

func TestDrive_SoftDeleteAndRestore(t *testing.T) {
	_, svc := setupDriveDB(t)
	ctx := context.Background()
	a, _ := svc.CreateFolder(ctx, nil, "a")
	b, _ := svc.CreateFolder(ctx, &a.ID, "b")

	if err := svc.SoftDelete(ctx, []int64{a.ID}); err != nil {
		t.Fatal(err)
	}
	got, err := svc.FindByID(ctx, b.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !got.DeletedAt.Valid {
		t.Fatalf("descendant not deleted: %+v", got)
	}
	if !got.DeleteBatchID.Valid {
		t.Fatalf("delete_batch_id not set")
	}

	// Active list under root should be empty.
	rows, _ := svc.List(ctx, nil, nil, "name", "asc")
	if len(rows) != 0 {
		t.Fatalf("expected empty active list, got %d", len(rows))
	}

	// Restore by root id restores both.
	if err := svc.Restore(ctx, a.ID); err != nil {
		t.Fatal(err)
	}
	got, _ = svc.FindByID(ctx, b.ID)
	if got.DeletedAt.Valid {
		t.Fatalf("descendant still deleted")
	}
}

func TestDrive_AutoRename(t *testing.T) {
	_, svc := setupDriveDB(t)
	ctx := context.Background()
	parent, _ := svc.CreateFolder(ctx, nil, "p")

	// Create a "file"-typed node directly via CreateFileNode (no real blob needed for the test).
	blob := filepath.Join("drive", "x.txt")
	abs := svc.BlobAbsPath(blob)
	_ = os.MkdirAll(filepath.Dir(abs), 0755)
	_ = os.WriteFile(abs, []byte("hi"), 0644)

	if _, err := svc.CreateFileNode(ctx, &parent.ID, "report.pdf", blob, "", 2); err != nil {
		t.Fatalf("create file: %v", err)
	}
	cand, err := svc.AutoRename(ctx, &parent.ID, "report.pdf")
	if err != nil {
		t.Fatal(err)
	}
	if cand != "report (1).pdf" {
		t.Fatalf("unexpected auto rename: %q", cand)
	}
}

func TestDrive_Breadcrumbs(t *testing.T) {
	_, svc := setupDriveDB(t)
	ctx := context.Background()
	a, _ := svc.CreateFolder(ctx, nil, "a")
	b, _ := svc.CreateFolder(ctx, &a.ID, "b")
	c, _ := svc.CreateFolder(ctx, &b.ID, "c")

	bc, err := svc.Breadcrumbs(ctx, c.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(bc) != 3 || bc[0].Name != "a" || bc[1].Name != "b" || bc[2].Name != "c" {
		t.Fatalf("breadcrumbs wrong: %+v", bc)
	}
}

// Sanity: NullInt64 round-trip via DriveNode.
func TestDrive_RootParentNull(t *testing.T) {
	_, svc := setupDriveDB(t)
	ctx := context.Background()
	n, err := svc.CreateFolder(ctx, nil, "root")
	if err != nil {
		t.Fatal(err)
	}
	if n.ParentID.Valid {
		t.Fatalf("expected NULL parent_id, got %v", n.ParentID)
	}
	_ = models.DriveNode{} // touch package to silence imports if unused
}

// Search results should include a slash-joined ancestor path so the UI can
// display the full directory of each hit.
func TestDrive_SearchPopulatesPath(t *testing.T) {
	_, svc := setupDriveDB(t)
	ctx := context.Background()
	a, _ := svc.CreateFolder(ctx, nil, "Photos")
	b, _ := svc.CreateFolder(ctx, &a.ID, "2024")
	leaf, _ := svc.CreateFolder(ctx, &b.ID, "vacation")
	rootHit, _ := svc.CreateFolder(ctx, nil, "vacationRoot")

	q := "vacation"
	out, err := svc.List(ctx, nil, &q, "", "")
	if err != nil {
		t.Fatal(err)
	}
	var sawLeaf, sawRoot bool
	for _, n := range out {
		switch n.ID {
		case leaf.ID:
			sawLeaf = true
			if n.Path != "Photos/2024" {
				t.Fatalf("leaf path = %q want Photos/2024", n.Path)
			}
		case rootHit.ID:
			sawRoot = true
			if n.Path != "" {
				t.Fatalf("root-level hit should have empty Path, got %q", n.Path)
			}
		}
	}
	if !sawLeaf || !sawRoot {
		t.Fatalf("missing search hits: leaf=%v root=%v results=%+v", sawLeaf, sawRoot, out)
	}
}

// List should populate ShareCount with the number of currently-active shares.
func TestDrive_ListPopulatesShareCount(t *testing.T) {
db, svc := setupDriveDB(t)
ctx := context.Background()
parent, _ := svc.CreateFolder(ctx, nil, "p")

blob := filepath.Join("drive", "y.txt")
_ = os.MkdirAll(filepath.Dir(svc.BlobAbsPath(blob)), 0755)
_ = os.WriteFile(svc.BlobAbsPath(blob), []byte("hi"), 0644)

f, err := svc.CreateFileNode(ctx, &parent.ID, "doc.txt", blob, "", 2)
if err != nil {
t.Fatal(err)
}

now := int64(1_700_000_000_000)
// 1 active (no expiry) + 1 active (future) + 1 expired
_, _ = db.Exec(
`INSERT INTO drive_shares (node_id, token_hash, token_prefix, expires_at, created_at) VALUES
 (?, ?, ?, NULL, ?),
 (?, ?, ?, ?, ?),
 (?, ?, ?, ?, ?)`,
f.ID, "h1", "h1", now,
f.ID, "h2", "h2", time.Now().Add(time.Hour).UnixMilli(), now,
f.ID, "h3", "h3", time.Now().Add(-time.Hour).UnixMilli(), now,
)

out, err := svc.List(ctx, &parent.ID, nil, "", "")
if err != nil {
t.Fatal(err)
}
var got int
for _, n := range out {
if n.ID == f.ID {
got = n.ShareCount
}
}
if got != 2 {
t.Fatalf("ShareCount = %d, want 2", got)
}
}

// Hard-deleting a node should cascade-delete its drive_shares rows.
func TestDrive_PurgeCascadesShares(t *testing.T) {
db, svc := setupDriveDB(t)
ctx := context.Background()
parent, _ := svc.CreateFolder(ctx, nil, "p")

blob := filepath.Join("drive", "z.txt")
_ = os.MkdirAll(filepath.Dir(svc.BlobAbsPath(blob)), 0755)
_ = os.WriteFile(svc.BlobAbsPath(blob), []byte("hi"), 0644)
f, err := svc.CreateFileNode(ctx, &parent.ID, "z.txt", blob, "", 2)
if err != nil {
t.Fatal(err)
}
if _, err := db.Exec(
`INSERT INTO drive_shares (node_id, token_hash, token_prefix, expires_at, created_at)
 VALUES (?, 'tk', 'tk', NULL, 1)`, f.ID); err != nil {
t.Fatal(err)
}

// Purge the parent folder; child file row + its share should be gone.
if err := svc.Purge(ctx, []int64{parent.ID}); err != nil {
t.Fatal(err)
}
var n int
_ = db.Get(&n, `SELECT COUNT(*) FROM drive_shares`)
if n != 0 {
t.Fatalf("expected drive_shares empty after purge, got %d rows", n)
}
}

// ListAll returns every share joined with the file's name + path; expired
// rows are filtered unless includeExpired is true. Shares whose underlying
// file is soft-deleted are excluded.
func TestDriveShare_ListAll(t *testing.T) {
db, svc := setupDriveDB(t)
ctx := context.Background()
share := NewDriveShareService(db, svc)

parent, _ := svc.CreateFolder(ctx, nil, "outer")
inner, _ := svc.CreateFolder(ctx, &parent.ID, "inner")

mk := func(parentID *int64, name string) *models.DriveNode {
blob := filepath.Join("drive", name)
_ = os.MkdirAll(filepath.Dir(svc.BlobAbsPath(blob)), 0755)
_ = os.WriteFile(svc.BlobAbsPath(blob), []byte("x"), 0644)
f, err := svc.CreateFileNode(ctx, parentID, name, blob, "", 1)
if err != nil {
t.Fatal(err)
}
return f
}
a := mk(&inner.ID, "a.txt")
b := mk(nil, "b.txt")
c := mk(nil, "c.txt") // will be soft-deleted

now := int64(1_700_000_000_000)
future := time.Now().Add(time.Hour).UnixMilli()
past := time.Now().Add(-time.Hour).UnixMilli()
_, err := db.Exec(`INSERT INTO drive_shares
(node_id, token_hash, token_prefix, expires_at, created_at) VALUES
(?, 'h1', 'h1', NULL,    ?),
(?, 'h2', 'h2', ?,        ?),
(?, 'h3', 'h3', ?,        ?),
(?, 'h4', 'h4', NULL,    ?)`,
a.ID, now,
b.ID, future, now+1,
b.ID, past, now+2, // expired
c.ID, now+3,       // file will be soft-deleted
)
if err != nil {
t.Fatal(err)
}
if err := svc.SoftDelete(ctx, []int64{c.ID}); err != nil {
t.Fatal(err)
}

rows, err := share.ListAll(ctx, false)
if err != nil {
t.Fatal(err)
}
if len(rows) != 2 {
t.Fatalf("active rows = %d, want 2 (got %+v)", len(rows), rows)
}
// rows are ordered by created_at DESC: b (future) first, a second
if rows[0].Name != "b.txt" || rows[0].Path != "" {
t.Errorf("row0 = %+v", rows[0])
}
if rows[1].Name != "a.txt" || rows[1].Path != "outer/inner" {
t.Errorf("row1 = %+v", rows[1])
}

all, err := share.ListAll(ctx, true)
if err != nil {
t.Fatal(err)
}
if len(all) != 3 { // includes expired b-share, excludes c (deleted file)
t.Fatalf("all rows = %d, want 3", len(all))
}
}

// PurgeExpired removes only rows with expires_at <= now.
func TestDriveShare_PurgeExpired(t *testing.T) {
db, svc := setupDriveDB(t)
ctx := context.Background()
share := NewDriveShareService(db, svc)

blob := filepath.Join("drive", "p.txt")
_ = os.MkdirAll(filepath.Dir(svc.BlobAbsPath(blob)), 0755)
_ = os.WriteFile(svc.BlobAbsPath(blob), []byte("x"), 0644)
f, err := svc.CreateFileNode(ctx, nil, "p.txt", blob, "", 1)
if err != nil {
t.Fatal(err)
}

now := time.Now().UnixMilli()
_, _ = db.Exec(`INSERT INTO drive_shares
(node_id, token_hash, token_prefix, expires_at, created_at) VALUES
(?, 'a', 'a', NULL,    ?),
(?, 'b', 'b', ?,        ?),
(?, 'c', 'c', ?,        ?)`,
f.ID, now,
f.ID, now-1, now,
f.ID, now+3600_000, now,
)

n, err := share.PurgeExpired(ctx)
if err != nil {
t.Fatal(err)
}
if n != 1 {
t.Fatalf("purged = %d, want 1", n)
}
var left int
_ = db.Get(&left, `SELECT COUNT(*) FROM drive_shares`)
if left != 2 {
t.Fatalf("remaining = %d, want 2", left)
}
}
