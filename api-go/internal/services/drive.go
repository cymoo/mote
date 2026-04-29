package services

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"mime"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/cymoo/mote/internal/config"
	"github.com/cymoo/mote/internal/models"
	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
)

var (
	ErrDriveNotFound      = errors.New("drive node not found")
	ErrDriveNameConflict  = errors.New("name already exists in this folder")
	ErrDriveCycle         = errors.New("cannot move folder into its own descendant")
	ErrDriveNotFolder     = errors.New("parent must be a folder")
	ErrDriveInvalidName   = errors.New("invalid name")
	ErrDriveInvalidParent = errors.New("invalid parent folder")
)

// DriveService handles tree CRUD for the drive feature.
type DriveService struct {
	db     *sqlx.DB
	config *config.UploadConfig
}

func NewDriveService(db *sqlx.DB, cfg *config.UploadConfig) *DriveService {
	// Ensure the drive subdirectory exists.
	if err := os.MkdirAll(filepath.Join(cfg.BasePath, "drive"), 0755); err != nil {
		panic(fmt.Sprintf("failed to create drive directory: %v", err))
	}
	if err := os.MkdirAll(filepath.Join(cfg.BasePath, "drive", "_chunks"), 0755); err != nil {
		panic(fmt.Sprintf("failed to create drive chunks directory: %v", err))
	}
	return &DriveService{db: db, config: cfg}
}

// BlobAbsPath returns the absolute filesystem path of a stored blob.
// blob_path is stored relative to the upload base, e.g. "drive/abc.png".
func (s *DriveService) BlobAbsPath(rel string) string {
	return filepath.Join(s.config.BasePath, rel)
}

func validName(name string) error {
	name = strings.TrimSpace(name)
	if name == "" || name == "." || name == ".." {
		return ErrDriveInvalidName
	}
	if strings.ContainsAny(name, `/\`) {
		return ErrDriveInvalidName
	}
	if len(name) > 255 {
		return ErrDriveInvalidName
	}
	return nil
}

// FindByID returns a node (deleted or not).
func (s *DriveService) FindByID(ctx context.Context, id int64) (*models.DriveNode, error) {
	var n models.DriveNode
	err := s.db.GetContext(ctx, &n, `SELECT * FROM drive_nodes WHERE id = ?`, id)
	if err == sql.ErrNoRows {
		return nil, ErrDriveNotFound
	}
	if err != nil {
		return nil, err
	}
	return &n, nil
}

// List returns immediate children of parentID (or root when nil), excluding deleted.
func (s *DriveService) List(ctx context.Context, parentID *int64, query *string, orderBy, sort string) ([]models.DriveNode, error) {
	args := []any{}
	var where string
	if parentID == nil {
		where = "parent_id IS NULL"
	} else {
		// Validate parent exists & is folder & not deleted.
		if _, err := s.requireActiveFolder(ctx, *parentID); err != nil {
			return nil, err
		}
		where = "parent_id = ?"
		args = append(args, *parentID)
	}
	where += " AND deleted_at IS NULL"
	if query != nil && strings.TrimSpace(*query) != "" {
		where = "deleted_at IS NULL AND name_lower LIKE ?"
		args = []any{"%" + strings.ToLower(strings.TrimSpace(*query)) + "%"}
	}

	col := "name_lower"
	switch orderBy {
	case "size":
		col = "size"
	case "updated_at":
		col = "updated_at"
	case "created_at":
		col = "created_at"
	case "name", "":
		col = "name_lower"
	}
	dir := "ASC"
	if strings.EqualFold(sort, "desc") {
		dir = "DESC"
	}

	q := fmt.Sprintf(
		`SELECT * FROM drive_nodes WHERE %s ORDER BY type DESC, %s %s, id ASC`,
		where, col, dir,
	)
	var out []models.DriveNode
	if err := s.db.SelectContext(ctx, &out, q, args...); err != nil {
		return nil, err
	}
	return out, nil
}

// ListTrash returns soft-deleted batch roots (the topmost deleted ancestor per batch).
func (s *DriveService) ListTrash(ctx context.Context) ([]models.DriveNode, error) {
	q := `
SELECT n.* FROM drive_nodes n
WHERE n.deleted_at IS NOT NULL
  AND (
    n.parent_id IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM drive_nodes p
      WHERE p.id = n.parent_id
        AND p.deleted_at IS NOT NULL
        AND p.delete_batch_id = n.delete_batch_id
    )
  )
ORDER BY n.deleted_at DESC, n.id DESC`
	var out []models.DriveNode
	if err := s.db.SelectContext(ctx, &out, q); err != nil {
		return nil, err
	}
	return out, nil
}

// Breadcrumbs returns the chain of ancestors for a node, root first.
func (s *DriveService) Breadcrumbs(ctx context.Context, id int64) ([]models.DriveBreadcrumb, error) {
	q := `
WITH RECURSIVE chain(id, name, parent_id, depth) AS (
  SELECT id, name, parent_id, 0 FROM drive_nodes WHERE id = ?
  UNION ALL
  SELECT n.id, n.name, n.parent_id, c.depth + 1
  FROM drive_nodes n JOIN chain c ON n.id = c.parent_id
)
SELECT id, name FROM chain ORDER BY depth DESC`
	var out []models.DriveBreadcrumb
	if err := s.db.SelectContext(ctx, &out, q, id); err != nil {
		return nil, err
	}
	return out, nil
}

// CreateFolder creates a new folder.
// Returns ErrDriveNameConflict on collision (DB-enforced).
func (s *DriveService) CreateFolder(ctx context.Context, parentID *int64, name string) (*models.DriveNode, error) {
	if err := validName(name); err != nil {
		return nil, err
	}
	if parentID != nil {
		if _, err := s.requireActiveFolder(ctx, *parentID); err != nil {
			return nil, err
		}
	}
	now := time.Now().UnixMilli()
	q := `INSERT INTO drive_nodes (parent_id, type, name, name_lower, created_at, updated_at)
	      VALUES (?, 'folder', ?, ?, ?, ?) RETURNING id`
	var id int64
	err := s.db.QueryRowxContext(ctx, q, parentID, name, strings.ToLower(name), now, now).Scan(&id)
	if err != nil {
		if isUniqueErr(err) {
			return nil, ErrDriveNameConflict
		}
		return nil, err
	}
	return s.FindByID(ctx, id)
}

// Rename renames a node within its current folder.
func (s *DriveService) Rename(ctx context.Context, id int64, newName string) error {
	if err := validName(newName); err != nil {
		return err
	}
	now := time.Now().UnixMilli()
	res, err := s.db.ExecContext(ctx,
		`UPDATE drive_nodes SET name = ?, name_lower = ?, updated_at = ?
		 WHERE id = ? AND deleted_at IS NULL`,
		newName, strings.ToLower(newName), now, id)
	if err != nil {
		if isUniqueErr(err) {
			return ErrDriveNameConflict
		}
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrDriveNotFound
	}
	return nil
}

// Move moves nodes into a new parent. newParentID = nil means root.
// Cycle prevention done in-transaction via recursive CTE.
func (s *DriveService) Move(ctx context.Context, ids []int64, newParentID *int64) error {
	if len(ids) == 0 {
		return nil
	}
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Validate new parent.
	if newParentID != nil {
		var typ string
		var deletedAt sql.NullInt64
		err := tx.QueryRowxContext(ctx,
			`SELECT type, deleted_at FROM drive_nodes WHERE id = ?`, *newParentID).
			Scan(&typ, &deletedAt)
		if err == sql.ErrNoRows {
			return ErrDriveInvalidParent
		}
		if err != nil {
			return err
		}
		if deletedAt.Valid {
			return ErrDriveInvalidParent
		}
		if typ != "folder" {
			return ErrDriveNotFolder
		}
	}

	now := time.Now().UnixMilli()
	for _, id := range ids {
		// Cycle check: ensure newParentID is not equal to id, and not a descendant of id.
		if newParentID != nil && *newParentID == id {
			return ErrDriveCycle
		}
		if newParentID != nil {
			var hit int
			err := tx.QueryRowxContext(ctx, `
WITH RECURSIVE descendants(id) AS (
  SELECT id FROM drive_nodes WHERE id = ?
  UNION ALL
  SELECT n.id FROM drive_nodes n JOIN descendants d ON n.parent_id = d.id
)
SELECT EXISTS(SELECT 1 FROM descendants WHERE id = ?)`, id, *newParentID).Scan(&hit)
			if err != nil {
				return err
			}
			if hit == 1 {
				return ErrDriveCycle
			}
		}

		_, err := tx.ExecContext(ctx,
			`UPDATE drive_nodes SET parent_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
			newParentID, now, id)
		if err != nil {
			if isUniqueErr(err) {
				return ErrDriveNameConflict
			}
			return err
		}
	}
	return tx.Commit()
}

// SoftDelete marks the given nodes (and all their descendants) as deleted, sharing
// a delete_batch_id so that Restore can resurrect exactly the same set.
func (s *DriveService) SoftDelete(ctx context.Context, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	batch := newToken(16)
	now := time.Now().UnixMilli()

	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	for _, id := range ids {
		_, err := tx.ExecContext(ctx, `
WITH RECURSIVE subtree(id) AS (
  SELECT id FROM drive_nodes WHERE id = ? AND deleted_at IS NULL
  UNION ALL
  SELECT n.id FROM drive_nodes n JOIN subtree s ON n.parent_id = s.id
  WHERE n.deleted_at IS NULL
)
UPDATE drive_nodes
SET deleted_at = ?, delete_batch_id = ?, updated_at = ?
WHERE id IN (SELECT id FROM subtree)`, id, now, batch, now)
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}

// Restore restores a node and all of its descendants that share the same delete_batch_id.
func (s *DriveService) Restore(ctx context.Context, id int64) error {
	n, err := s.FindByID(ctx, id)
	if err != nil {
		return err
	}
	if !n.DeletedAt.Valid {
		return nil
	}
	if !n.DeleteBatchID.Valid {
		// Unknown batch — restore just this node.
		_, err := s.db.ExecContext(ctx,
			`UPDATE drive_nodes SET deleted_at = NULL, delete_batch_id = NULL WHERE id = ?`, id)
		return err
	}
	// Validate target name doesn't collide with an active sibling.
	var conflict int
	err = s.db.QueryRowxContext(ctx, `
SELECT EXISTS(
  SELECT 1 FROM drive_nodes
  WHERE COALESCE(parent_id, 0) = COALESCE(?, 0)
    AND name_lower = ?
    AND deleted_at IS NULL
)`, n.ParentID, n.NameLower).Scan(&conflict)
	if err != nil {
		return err
	}
	if conflict == 1 {
		return ErrDriveNameConflict
	}
	_, err = s.db.ExecContext(ctx,
		`UPDATE drive_nodes SET deleted_at = NULL, delete_batch_id = NULL
		 WHERE delete_batch_id = ?`, n.DeleteBatchID.String)
	return err
}

// Purge hard-deletes the given nodes and all their descendants, removing blob files.
func (s *DriveService) Purge(ctx context.Context, ids []int64) error {
	for _, id := range ids {
		if err := s.purgeOne(ctx, id); err != nil {
			return err
		}
	}
	return nil
}

func (s *DriveService) purgeOne(ctx context.Context, id int64) error {
	type row struct {
		ID       int64          `db:"id"`
		BlobPath sql.NullString `db:"blob_path"`
	}
	q := `
WITH RECURSIVE subtree(id) AS (
  SELECT id FROM drive_nodes WHERE id = ?
  UNION ALL
  SELECT n.id FROM drive_nodes n JOIN subtree s ON n.parent_id = s.id
)
SELECT n.id, n.blob_path FROM drive_nodes n WHERE n.id IN (SELECT id FROM subtree)`
	var rows []row
	if err := s.db.SelectContext(ctx, &rows, q, id); err != nil {
		return err
	}
	if len(rows) == 0 {
		return ErrDriveNotFound
	}

	// Foreign keys cascade: deleting the root row removes descendants.
	if _, err := s.db.ExecContext(ctx, `DELETE FROM drive_nodes WHERE id = ?`, id); err != nil {
		return err
	}
	for _, r := range rows {
		if r.BlobPath.Valid {
			_ = os.Remove(s.BlobAbsPath(r.BlobPath.String))
		}
	}
	return nil
}

// CollectDescendants returns the full descendant set (excluding deleted) for a folder.
// Each row carries a relative path inside the subtree (root-relative, no leading slash).
type DescendantRow struct {
	ID       int64          `db:"id"`
	Type     string         `db:"type"`
	Name     string         `db:"name"`
	BlobPath sql.NullString `db:"blob_path"`
	RelPath  string         `db:"rel_path"`
}

func (s *DriveService) CollectDescendants(ctx context.Context, rootID int64) ([]DescendantRow, error) {
	q := `
WITH RECURSIVE subtree(id, type, name, blob_path, rel_path) AS (
  SELECT id, type, name, blob_path, name AS rel_path
  FROM drive_nodes WHERE id = ? AND deleted_at IS NULL
  UNION ALL
  SELECT n.id, n.type, n.name, n.blob_path, s.rel_path || '/' || n.name
  FROM drive_nodes n
  JOIN subtree s ON n.parent_id = s.id
  WHERE n.deleted_at IS NULL
)
SELECT id, type, name, blob_path, rel_path FROM subtree`
	var out []DescendantRow
	if err := s.db.SelectContext(ctx, &out, q, rootID); err != nil {
		return nil, err
	}
	return out, nil
}

// requireActiveFolder ensures the given id is an existing, undeleted folder.
func (s *DriveService) requireActiveFolder(ctx context.Context, id int64) (*models.DriveNode, error) {
	n, err := s.FindByID(ctx, id)
	if err != nil {
		return nil, err
	}
	if n.DeletedAt.Valid {
		return nil, ErrDriveNotFound
	}
	if n.Type != "folder" {
		return nil, ErrDriveNotFolder
	}
	return n, nil
}

// CreateFileNode inserts a new file row. Used by the upload service after
// the blob has been written to disk. Returns the inserted node or
// ErrDriveNameConflict on collision (caller can then apply a rename strategy).
func (s *DriveService) CreateFileNode(
	ctx context.Context,
	parentID *int64,
	name, blobPath, mimeType, ext, hash string,
	size int64,
) (*models.DriveNode, error) {
	if err := validName(name); err != nil {
		return nil, err
	}
	if parentID != nil {
		if _, err := s.requireActiveFolder(ctx, *parentID); err != nil {
			return nil, err
		}
	}
	now := time.Now().UnixMilli()
	var id int64
	err := s.db.QueryRowxContext(ctx, `
INSERT INTO drive_nodes (parent_id, type, name, name_lower, blob_path, size, mime_type, ext, hash, created_at, updated_at)
VALUES (?, 'file', ?, ?, ?, ?, ?, ?, NULLIF(?, ''), ?, ?) RETURNING id`,
		parentID, name, strings.ToLower(name), blobPath, size, mimeType, ext, hash, now, now).Scan(&id)
	if err != nil {
		if isUniqueErr(err) {
			return nil, ErrDriveNameConflict
		}
		return nil, err
	}
	return s.FindByID(ctx, id)
}

// ReplaceFileNode replaces an existing same-name file in `parentID` (overwrite policy).
// The previous blob is removed. Used by upload "overwrite" collision strategy.
func (s *DriveService) ReplaceFileNode(
	ctx context.Context,
	parentID *int64,
	name, blobPath, mimeType, ext, hash string,
	size int64,
) (*models.DriveNode, error) {
	if err := validName(name); err != nil {
		return nil, err
	}
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	var existing models.DriveNode
	err = tx.GetContext(ctx, &existing, `
SELECT * FROM drive_nodes
WHERE COALESCE(parent_id, 0) = COALESCE(?, 0)
  AND name_lower = ?
  AND deleted_at IS NULL`, parentID, strings.ToLower(name))
	if err != nil && err != sql.ErrNoRows {
		return nil, err
	}

	now := time.Now().UnixMilli()

	if err == sql.ErrNoRows || existing.Type != "file" {
		// Nothing to overwrite (or existing is a folder); insert fresh.
		var id int64
		if err := tx.QueryRowxContext(ctx, `
INSERT INTO drive_nodes (parent_id, type, name, name_lower, blob_path, size, mime_type, ext, hash, created_at, updated_at)
VALUES (?, 'file', ?, ?, ?, ?, ?, ?, NULLIF(?, ''), ?, ?) RETURNING id`,
			parentID, name, strings.ToLower(name), blobPath, size, mimeType, ext, hash, now, now,
		).Scan(&id); err != nil {
			if isUniqueErr(err) {
				return nil, ErrDriveNameConflict
			}
			return nil, err
		}
		if err := tx.Commit(); err != nil {
			return nil, err
		}
		return s.FindByID(ctx, id)
	}

	// Overwrite the existing file row.
	oldBlob := existing.BlobPath.String
	_, err = tx.ExecContext(ctx, `
UPDATE drive_nodes
SET blob_path = ?, size = ?, mime_type = ?, ext = ?, hash = NULLIF(?, ''), updated_at = ?
WHERE id = ?`, blobPath, size, mimeType, ext, hash, now, existing.ID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	if oldBlob != "" && oldBlob != blobPath {
		_ = os.Remove(s.BlobAbsPath(oldBlob))
	}
	return s.FindByID(ctx, existing.ID)
}

// FindActiveSibling returns the active node with the given name in the given folder, or nil.
func (s *DriveService) FindActiveSibling(ctx context.Context, parentID *int64, name string) (*models.DriveNode, error) {
	var n models.DriveNode
	err := s.db.GetContext(ctx, &n, `
SELECT * FROM drive_nodes
WHERE COALESCE(parent_id, 0) = COALESCE(?, 0)
  AND name_lower = ?
  AND deleted_at IS NULL`, parentID, strings.ToLower(name))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &n, nil
}

// AutoRename returns a non-conflicting filename in `parentID` based on `name`.
// "report.pdf" -> "report (1).pdf", "report (2).pdf", ...
func (s *DriveService) AutoRename(ctx context.Context, parentID *int64, name string) (string, error) {
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for i := 1; i < 1000; i++ {
		cand := fmt.Sprintf("%s (%d)%s", stem, i, ext)
		sib, err := s.FindActiveSibling(ctx, parentID, cand)
		if err != nil {
			return "", err
		}
		if sib == nil {
			return cand, nil
		}
	}
	return "", fmt.Errorf("could not allocate unique name for %q", name)
}

// MimeTypeFromExt is a small helper used when storing files.
func MimeTypeFromExt(ext string) string {
	if ext == "" {
		return "application/octet-stream"
	}
	if mt := mime.TypeByExtension(ext); mt != "" {
		return mt
	}
	return "application/octet-stream"
}

// newToken returns a hex-encoded random token of n bytes.
func newToken(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// newBlobName generates a flat blob filename (UUID + extension).
func newBlobName(originalName string) string {
	ext := strings.ToLower(filepath.Ext(originalName))
	id := strings.ReplaceAll(uuid.New().String(), "-", "")
	if ext == "" {
		return id
	}
	return id + ext
}

// isUniqueErr reports whether err is a SQLite unique-constraint violation.
func isUniqueErr(err error) bool {
	if err == nil {
		return false
	}
	s := err.Error()
	return strings.Contains(s, "UNIQUE constraint failed") ||
		strings.Contains(s, "constraint failed: UNIQUE")
}
