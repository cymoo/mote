package services

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/cymoo/mote/internal/config"
	"github.com/cymoo/mote/internal/models"
	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	sqlite "modernc.org/sqlite"
)

// likeEscape escapes user input for use inside a LIKE pattern. The caller
// must use ESCAPE '\' on the SQL side. Without this, a query of "_" or "%"
// would match every row.
func likeEscape(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return r.Replace(s)
}

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
// When query is non-empty, it performs a global name search (parentID is ignored).
func (s *DriveService) List(ctx context.Context, parentID *int64, query *string, orderBy, sort string) ([]models.DriveNode, error) {
	hasQuery := query != nil && strings.TrimSpace(*query) != ""

	var where string
	var args []any
	if hasQuery {
		// Global LIKE search; escape user wildcards.
		pattern := "%" + strings.ToLower(likeEscape(strings.TrimSpace(*query))) + "%"
		where = `deleted_at IS NULL AND LOWER(name) LIKE ? ESCAPE '\'`
		args = []any{pattern}
	} else if parentID == nil {
		where = "parent_id IS NULL AND deleted_at IS NULL"
	} else {
		if _, err := s.requireActiveFolder(ctx, *parentID); err != nil {
			return nil, err
		}
		where = "parent_id = ? AND deleted_at IS NULL"
		args = []any{*parentID}
	}

	col := "LOWER(name)"
	switch orderBy {
	case "size":
		col = "size"
	case "updated_at":
		col = "updated_at"
	case "created_at":
		col = "created_at"
	case "name", "":
		col = "LOWER(name)"
	}
	dir := "ASC"
	if strings.EqualFold(sort, "desc") {
		dir = "DESC"
	}

	// Folders before files: type='folder' < type='file' lexicographically, so
	// CASE expression keeps intent clear regardless of future type values.
	q := fmt.Sprintf(
		`SELECT * FROM drive_nodes WHERE %s
		 ORDER BY CASE WHEN type = 'folder' THEN 0 ELSE 1 END, %s %s, id ASC`,
		where, col, dir,
	)
	var out []models.DriveNode
	if err := s.db.SelectContext(ctx, &out, q, args...); err != nil {
		return nil, err
	}
	if hasQuery && len(out) > 0 {
		if err := s.populatePaths(ctx, out); err != nil {
			return nil, err
		}
	}
	if len(out) > 0 {
		if err := s.populateShareCounts(ctx, out); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// populateShareCounts fills DriveNode.ShareCount with the number of currently
// active (non-expired) shares per file node. Folders always remain 0.
func (s *DriveService) populateShareCounts(ctx context.Context, nodes []models.DriveNode) error {
	ids := make([]int64, 0, len(nodes))
	idx := make(map[int64]int, len(nodes))
	for i, n := range nodes {
		if n.Type != "file" {
			continue
		}
		ids = append(ids, n.ID)
		idx[n.ID] = i
	}
	if len(ids) == 0 {
		return nil
	}
	q, args, err := sqlx.In(`
SELECT node_id, COUNT(*) AS c FROM drive_shares
WHERE node_id IN (?) AND (expires_at IS NULL OR expires_at > ?)
GROUP BY node_id`, ids, time.Now().UnixMilli())
	if err != nil {
		return err
	}
	rows, err := s.db.QueryxContext(ctx, s.db.Rebind(q), args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var nid int64
		var c int
		if err := rows.Scan(&nid, &c); err != nil {
			return err
		}
		if i, ok := idx[nid]; ok {
			nodes[i].ShareCount = c
		}
	}
	return rows.Err()
}

// populatePaths fills DriveNode.Path with the slash-joined ancestor names
// (excluding the node itself) for each input row.
func (s *DriveService) populatePaths(ctx context.Context, nodes []models.DriveNode) error {
	cache := map[int64]string{}
	for i := range nodes {
		if !nodes[i].ParentID.Valid {
			continue
		}
		pid := nodes[i].ParentID.Int64
		if p, ok := cache[pid]; ok {
			nodes[i].Path = p
			continue
		}
		bcs, err := s.Breadcrumbs(ctx, pid)
		if err != nil {
			return err
		}
		parts := make([]string, 0, len(bcs))
		for _, bc := range bcs {
			parts = append(parts, bc.Name)
		}
		p := strings.Join(parts, "/")
		cache[pid] = p
		nodes[i].Path = p
	}
	return nil
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
	q := `INSERT INTO drive_nodes (parent_id, type, name, created_at, updated_at)
	      VALUES (?, 'folder', ?, ?, ?) RETURNING id`
	var id int64
	err := s.db.QueryRowxContext(ctx, q, parentID, name, now, now).Scan(&id)
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
		`UPDATE drive_nodes SET name = ?, updated_at = ?
		 WHERE id = ? AND deleted_at IS NULL`,
		newName, now, id)
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
// A batch may contain multiple roots (when SoftDelete was called with several ids);
// we pre-check sibling-name conflicts for every root so the caller gets a clean
// ErrDriveNameConflict instead of a low-level UNIQUE constraint error.
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

	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// All deleted roots in this batch (i.e. nodes whose parent isn't part of the same batch).
	var roots []models.DriveNode
	err = tx.SelectContext(ctx, &roots, `
SELECT * FROM drive_nodes n
WHERE n.delete_batch_id = ?
  AND (
    n.parent_id IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM drive_nodes p
      WHERE p.id = n.parent_id AND p.delete_batch_id = n.delete_batch_id
    )
  )`, n.DeleteBatchID.String)
	if err != nil {
		return err
	}
	for _, r := range roots {
		var hit int
		err := tx.QueryRowxContext(ctx, `
SELECT EXISTS(
  SELECT 1 FROM drive_nodes
  WHERE COALESCE(parent_id, 0) = COALESCE(?, 0)
    AND LOWER(name) = LOWER(?)
    AND deleted_at IS NULL
)`, r.ParentID, r.Name).Scan(&hit)
		if err != nil {
			return err
		}
		if hit == 1 {
			return ErrDriveNameConflict
		}
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE drive_nodes SET deleted_at = NULL, delete_batch_id = NULL
		 WHERE delete_batch_id = ?`, n.DeleteBatchID.String); err != nil {
		return err
	}
	return tx.Commit()
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
			s.PurgeThumb(r.BlobPath.String)
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
//
// Note: mime_type / ext are not stored — they are derived from the filename
// at read time (see DriveNode.MimeType / .Ext).
func (s *DriveService) CreateFileNode(
	ctx context.Context,
	parentID *int64,
	name, blobPath, hash string,
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
INSERT INTO drive_nodes (parent_id, type, name, blob_path, size, hash, created_at, updated_at)
VALUES (?, 'file', ?, ?, ?, NULLIF(?, ''), ?, ?) RETURNING id`,
		parentID, name, blobPath, size, hash, now, now).Scan(&id)
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
	name, blobPath, hash string,
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
  AND LOWER(name) = ?
  AND deleted_at IS NULL`, parentID, strings.ToLower(name))
	if err != nil && err != sql.ErrNoRows {
		return nil, err
	}

	now := time.Now().UnixMilli()

	if err == sql.ErrNoRows || existing.Type != "file" {
		// Nothing to overwrite (or existing is a folder); insert fresh.
		var id int64
		if err := tx.QueryRowxContext(ctx, `
INSERT INTO drive_nodes (parent_id, type, name, blob_path, size, hash, created_at, updated_at)
VALUES (?, 'file', ?, ?, ?, NULLIF(?, ''), ?, ?) RETURNING id`,
			parentID, name, blobPath, size, hash, now, now,
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
SET blob_path = ?, size = ?, hash = NULLIF(?, ''), updated_at = ?
WHERE id = ?`, blobPath, size, hash, now, existing.ID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	if oldBlob != "" && oldBlob != blobPath {
		_ = os.Remove(s.BlobAbsPath(oldBlob))
		s.PurgeThumb(oldBlob)
	}
	return s.FindByID(ctx, existing.ID)
}

// FindActiveSibling returns the active node with the given name in the given folder, or nil.
func (s *DriveService) FindActiveSibling(ctx context.Context, parentID *int64, name string) (*models.DriveNode, error) {
	var n models.DriveNode
	err := s.db.GetContext(ctx, &n, `
SELECT * FROM drive_nodes
WHERE COALESCE(parent_id, 0) = COALESCE(?, 0)
  AND LOWER(name) = ?
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
//
// Single SQL pass: scan siblings whose name looks like "stem (N)ext" and pick
// max(N)+1. If the original "stem.ext" itself isn't taken, returns it as is.
func (s *DriveService) AutoRename(ctx context.Context, parentID *int64, name string) (string, error) {
	if sib, err := s.FindActiveSibling(ctx, parentID, name); err != nil {
		return "", err
	} else if sib == nil {
		return name, nil
	}
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)

	// Match the literal "stem (N)ext" — prefix/suffix LIKE with wildcard escape.
	prefix := likeEscape(stem) + " (%"
	suffix := `%)` + likeEscape(ext)

	type row struct {
		Name string `db:"name"`
	}
	var rows []row
	err := s.db.SelectContext(ctx, &rows, `
SELECT name FROM drive_nodes
WHERE COALESCE(parent_id, 0) = COALESCE(?, 0)
  AND deleted_at IS NULL
  AND name LIKE ? ESCAPE '\'
  AND name LIKE ? ESCAPE '\'`, parentID, prefix, suffix)
	if err != nil {
		return "", err
	}
	maxN := 0
	for _, r := range rows {
		// Extract the integer between the last "(" and ")" before ext.
		mid := strings.TrimSuffix(r.Name, ext)
		i := strings.LastIndex(mid, " (")
		if i < 0 {
			continue
		}
		num := strings.TrimSuffix(mid[i+2:], ")")
		if n, err := strconv.Atoi(num); err == nil && n > maxN {
			maxN = n
		}
	}
	return fmt.Sprintf("%s (%d)%s", stem, maxN+1, ext), nil
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
// Uses typed assertion against modernc.org/sqlite's *Error (extended codes
// 1555 = CONSTRAINT_PRIMARYKEY, 2067 = CONSTRAINT_UNIQUE) and falls back to
// a string match for safety across driver versions.
func isUniqueErr(err error) bool {
	if err == nil {
		return false
	}
	var se *sqlite.Error
	if errors.As(err, &se) {
		switch se.Code() {
		case 1555, 2067:
			return true
		}
	}
	msg := err.Error()
	return strings.Contains(msg, "UNIQUE constraint failed") ||
		strings.Contains(msg, "constraint failed: UNIQUE")
}
