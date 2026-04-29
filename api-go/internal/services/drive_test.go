package services

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

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
  name_lower TEXT NOT NULL,
  blob_path TEXT,
  size INTEGER,
  mime_type TEXT,
  ext TEXT,
  hash TEXT,
  deleted_at INTEGER,
  delete_batch_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX drive_nodes_unique_active
  ON drive_nodes(COALESCE(parent_id, 0), name_lower)
  WHERE deleted_at IS NULL;
CREATE INDEX drive_nodes_parent ON drive_nodes(parent_id, deleted_at);
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

	if _, err := svc.CreateFileNode(ctx, &parent.ID, "report.pdf", blob, "application/pdf", ".pdf", "", 2); err != nil {
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
