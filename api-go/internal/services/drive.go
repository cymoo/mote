package services

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
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
	ErrDriveInvalidBlob   = errors.New("invalid drive blob path")
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

// BlobAccelRedirectURI maps a stored drive blob path to the configured nginx
// internal URI. It accepts only direct children of drive/ because completed
// uploads are stored as drive/<generated-name>; internal caches/chunks must
// never be addressable through media endpoints.
func (s *DriveService) BlobAccelRedirectURI(rel string) (string, bool, error) {
	prefix := strings.TrimRight(strings.TrimSpace(s.config.AccelRedirectPrefix), "/")
	if prefix == "" {
		return "", false, nil
	}
	if !strings.HasPrefix(prefix, "/") {
		return "", true, ErrDriveInvalidBlob
	}
	if filepath.IsAbs(rel) {
		return "", true, ErrDriveInvalidBlob
	}
	clean := path.Clean(filepath.ToSlash(rel))
	dir, name := path.Split(clean)
	if dir != "drive/" || name == "" || name == "." || name == ".." {
		return "", true, ErrDriveInvalidBlob
	}
	return prefix + "/" + url.PathEscape(name), true, nil
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
// active (non-expired) shares per node — files and folders alike.
func (s *DriveService) populateShareCounts(ctx context.Context, nodes []models.DriveNode) error {
	ids := make([]int64, 0, len(nodes))
	idx := make(map[int64]int, len(nodes))
	for i, n := range nodes {
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
	parentIDs := make([]int64, 0, len(nodes))
	seen := make(map[int64]bool, len(nodes))
	for i := range nodes {
		if !nodes[i].ParentID.Valid {
			continue
		}
		pid := nodes[i].ParentID.Int64
		if !seen[pid] {
			seen[pid] = true
			parentIDs = append(parentIDs, pid)
		}
	}
	if len(parentIDs) == 0 {
		return nil
	}

	idsJSON, err := json.Marshal(parentIDs)
	if err != nil {
		return fmt.Errorf("marshaling parent ids: %w", err)
	}

	type pathPart struct {
		ParentID int64  `db:"parent_id"`
		Name     string `db:"name"`
	}

	var rows []pathPart
	if err := s.db.SelectContext(ctx, &rows, `
WITH RECURSIVE chain(parent_id, id, name, ancestor_parent_id, depth) AS (
  SELECT p.id, p.id, p.name, p.parent_id, 0
  FROM drive_nodes p
  WHERE p.id IN (SELECT value FROM json_each(?))
  UNION ALL
  SELECT chain.parent_id, n.id, n.name, n.parent_id, chain.depth + 1
  FROM drive_nodes n
  JOIN chain ON n.id = chain.ancestor_parent_id
)
SELECT parent_id, name
FROM chain
ORDER BY parent_id, depth DESC`, string(idsJSON)); err != nil {
		return err
	}

	partsByParent := make(map[int64][]string, len(parentIDs))
	for _, row := range rows {
		partsByParent[row.ParentID] = append(partsByParent[row.ParentID], row.Name)
	}
	paths := make(map[int64]string, len(partsByParent))
	for parentID, parts := range partsByParent {
		paths[parentID] = strings.Join(parts, "/")
	}
	for i := range nodes {
		if nodes[i].ParentID.Valid {
			nodes[i].Path = paths[nodes[i].ParentID.Int64]
		}
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

// Restore restores a node and its descendants from trash. Multi-select deletes
// can put several roots in one delete_batch_id; restoring one trash entry must
// not resurrect its sibling roots from the same batch.
func (s *DriveService) Restore(ctx context.Context, id int64) error {
	n, err := s.FindByID(ctx, id)
	if err != nil {
		return err
	}
	if !n.DeletedAt.Valid {
		return nil
	}
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if !n.DeleteBatchID.Valid {
		var hit int
		err := tx.QueryRowxContext(ctx, `
SELECT EXISTS(
  SELECT 1 FROM drive_nodes
  WHERE COALESCE(parent_id, 0) = COALESCE(?, 0)
    AND LOWER(name) = LOWER(?)
    AND deleted_at IS NULL
)`, n.ParentID, n.Name).Scan(&hit)
		if err != nil {
			return err
		}
		if hit == 1 {
			return ErrDriveNameConflict
		}
		if _, err := tx.ExecContext(ctx,
			`UPDATE drive_nodes SET deleted_at = NULL, delete_batch_id = NULL WHERE id = ?`, id); err != nil {
			return err
		}
		return tx.Commit()
	}

	var conflicts int
	err = tx.QueryRowxContext(ctx, `
WITH RECURSIVE subtree(id) AS (
  SELECT id FROM drive_nodes WHERE id = ? AND deleted_at IS NOT NULL
  UNION ALL
  SELECT n.id FROM drive_nodes n JOIN subtree s ON n.parent_id = s.id
  WHERE n.deleted_at IS NOT NULL AND n.delete_batch_id = ?
)
SELECT COUNT(*)
FROM drive_nodes r
WHERE r.id IN (SELECT id FROM subtree)
  AND EXISTS (
    SELECT 1 FROM drive_nodes a
    WHERE COALESCE(a.parent_id, 0) = COALESCE(r.parent_id, 0)
      AND LOWER(a.name) = LOWER(r.name)
      AND a.deleted_at IS NULL
      AND a.id NOT IN (SELECT id FROM subtree)
  )`, id, n.DeleteBatchID.String).Scan(&conflicts)
	if err != nil {
		return err
	}
	if conflicts > 0 {
		return ErrDriveNameConflict
	}

	if _, err := tx.ExecContext(ctx, `
WITH RECURSIVE subtree(id) AS (
  SELECT id FROM drive_nodes WHERE id = ? AND deleted_at IS NOT NULL
  UNION ALL
  SELECT n.id FROM drive_nodes n JOIN subtree s ON n.parent_id = s.id
  WHERE n.deleted_at IS NOT NULL AND n.delete_batch_id = ?
)
UPDATE drive_nodes
SET deleted_at = NULL, delete_batch_id = NULL
WHERE id IN (SELECT id FROM subtree)`, id, n.DeleteBatchID.String); err != nil {
		return err
	}
	return tx.Commit()
}

// Purge hard-deletes the given nodes and all their descendants, removing blob files.
func (s *DriveService) Purge(ctx context.Context, ids []int64) error {
	for _, id := range ids {
		if err := s.purgeOne(ctx, id); err != nil {
			// A node may already be gone when an ancestor earlier in the batch
			// cascade-deleted it — e.g. emptying a trash that holds both a
			// folder and its separately-batched deleted children. Treat the
			// already-removed node as successfully purged.
			if errors.Is(err, ErrDriveNotFound) {
				continue
			}
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

	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var rows []row
	if err := tx.SelectContext(ctx, &rows, q, id); err != nil {
		return err
	}
	if len(rows) == 0 {
		return ErrDriveNotFound
	}

	// Foreign keys cascade: deleting the root row removes descendants.
	if _, err := tx.ExecContext(ctx, `DELETE FROM drive_nodes WHERE id = ?`, id); err != nil {
		return err
	}

	// Blobs can be shared by rows outside this subtree (copies, deduplicated
	// uploads). Decide which blobs became orphans INSIDE the tx — SQLite's
	// single writer serializes this against a concurrent Copy — but remove
	// files only after commit so a rollback can't have deleted live data.
	blobs := make(map[string]struct{}, len(rows))
	for _, r := range rows {
		if r.BlobPath.Valid && r.BlobPath.String != "" {
			blobs[r.BlobPath.String] = struct{}{}
		}
	}
	orphans := make([]string, 0, len(blobs))
	for blob := range blobs {
		var refs int
		if err := tx.GetContext(ctx, &refs,
			`SELECT COUNT(*) FROM drive_nodes WHERE blob_path = ?`, blob); err != nil {
			return err
		}
		if refs == 0 {
			orphans = append(orphans, blob)
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}

	for _, blob := range orphans {
		_ = os.Remove(s.BlobAbsPath(blob))
		s.PurgeThumb(blob)
	}
	return nil
}

// removeBlobIfOrphan removes the blob file and its cached thumbnail when no
// drive_nodes row (active or trashed) references blobPath anymore. Blobs can
// be shared by several rows (copies, deduplicated uploads), so removal must
// always be gated on this check. Call it AFTER the rows that dropped the
// reference have been committed.
func (s *DriveService) removeBlobIfOrphan(ctx context.Context, blobPath string) {
	if blobPath == "" {
		return
	}
	var refs int
	if err := s.db.GetContext(ctx, &refs,
		`SELECT COUNT(*) FROM drive_nodes WHERE blob_path = ?`, blobPath); err != nil || refs > 0 {
		return
	}
	_ = os.Remove(s.BlobAbsPath(blobPath))
	s.PurgeThumb(blobPath)
}

// FindReusableBlob returns the blob_path of an existing node (active or
// trashed) with the same content hash and size whose file is still present
// on disk, or "" when there is none. Used to deduplicate uploads.
func (s *DriveService) FindReusableBlob(ctx context.Context, hash string, size int64) (string, error) {
	if hash == "" {
		return "", nil
	}
	var candidates []string
	if err := s.db.SelectContext(ctx, &candidates, `
SELECT DISTINCT blob_path FROM drive_nodes
WHERE hash = ? AND size = ? AND blob_path IS NOT NULL
LIMIT 8`, hash, size); err != nil {
		return "", err
	}
	for _, blob := range candidates {
		if _, err := os.Stat(s.BlobAbsPath(blob)); err == nil {
			return blob, nil
		}
	}
	return "", nil
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
		s.removeBlobIfOrphan(ctx, oldBlob)
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

// ---------- copy / star / usage ----------

// Copy deep-copies nodes into newParentID (nil = root), one id at a time.
// File copies reference the SAME blob_path — zero disk cost; refcounted blob
// removal keeps shared blobs alive. Copies get fresh timestamps and never
// carry stars or shares. Copying a folder into its own subtree is rejected
// (ErrDriveCycle), matching Move. Destination name conflicts resolve via
// AutoRename ("name (1)"), so duplicate-in-place works naturally.
func (s *DriveService) Copy(ctx context.Context, ids []int64, newParentID *int64) ([]models.DriveNode, error) {
	if newParentID != nil {
		if _, err := s.requireActiveFolder(ctx, *newParentID); err != nil {
			return nil, err
		}
	}
	out := make([]models.DriveNode, 0, len(ids))
	for _, id := range ids {
		n, err := s.copyOne(ctx, id, newParentID)
		if err != nil {
			return nil, err
		}
		out = append(out, *n)
	}
	return out, nil
}

func (s *DriveService) copyOne(ctx context.Context, id int64, newParentID *int64) (*models.DriveNode, error) {
	src, err := s.FindByID(ctx, id)
	if err != nil {
		return nil, err
	}
	if src.DeletedAt.Valid {
		return nil, ErrDriveNotFound
	}
	// Cycle check: copying a folder into itself or its own descendant would
	// mean copying the destination into itself; reject like Move does.
	if newParentID != nil && src.Type == "folder" {
		if *newParentID == id {
			return nil, ErrDriveCycle
		}
		var hit int
		err := s.db.QueryRowxContext(ctx, `
WITH RECURSIVE descendants(id) AS (
  SELECT id FROM drive_nodes WHERE id = ?
  UNION ALL
  SELECT n.id FROM drive_nodes n JOIN descendants d ON n.parent_id = d.id
)
SELECT EXISTS(SELECT 1 FROM descendants WHERE id = ?)`, id, *newParentID).Scan(&hit)
		if err != nil {
			return nil, err
		}
		if hit == 1 {
			return nil, ErrDriveCycle
		}
	}

	// Pre-tx, read-only; the unique index backstops races (→ conflict error).
	rootName, err := s.AutoRename(ctx, newParentID, src.Name)
	if err != nil {
		return nil, err
	}

	type snapRow struct {
		ID       int64          `db:"id"`
		ParentID sql.NullInt64  `db:"parent_id"`
		Type     string         `db:"type"`
		Name     string         `db:"name"`
		BlobPath sql.NullString `db:"blob_path"`
		Size     sql.NullInt64  `db:"size"`
		Hash     sql.NullString `db:"hash"`
		Depth    int            `db:"depth"`
	}

	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	// Snapshot the whole source subtree up-front (depth-ordered so parents
	// are copied before children); inserting from the snapshot means freshly
	// created copies can never be re-visited.
	var snap []snapRow
	if err := tx.SelectContext(ctx, &snap, `
WITH RECURSIVE subtree(id, parent_id, type, name, blob_path, size, hash, depth) AS (
  SELECT id, parent_id, type, name, blob_path, size, hash, 0
  FROM drive_nodes WHERE id = ? AND deleted_at IS NULL
  UNION ALL
  SELECT n.id, n.parent_id, n.type, n.name, n.blob_path, n.size, n.hash, s.depth + 1
  FROM drive_nodes n JOIN subtree s ON n.parent_id = s.id
  WHERE n.deleted_at IS NULL
)
SELECT id, parent_id, type, name, blob_path, size, hash, depth
FROM subtree ORDER BY depth, id`, id); err != nil {
		return nil, err
	}
	if len(snap) == 0 {
		return nil, ErrDriveNotFound
	}

	now := time.Now().UnixMilli()
	idMap := make(map[int64]int64, len(snap))
	var newRootID int64
	for _, r := range snap {
		var parentID *int64
		name := r.Name
		if r.ID == id {
			parentID = newParentID
			name = rootName
		} else {
			np := idMap[r.ParentID.Int64]
			parentID = &np
		}
		var newID int64
		if err := tx.QueryRowxContext(ctx, `
INSERT INTO drive_nodes (parent_id, type, name, blob_path, size, hash, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
			parentID, r.Type, name, r.BlobPath, r.Size, r.Hash, now, now).Scan(&newID); err != nil {
			if isUniqueErr(err) {
				return nil, ErrDriveNameConflict
			}
			return nil, err
		}
		idMap[r.ID] = newID
		if r.ID == id {
			newRootID = newID
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.FindByID(ctx, newRootID)
}

// EnsureFolderPath walks/creates the folder chain relPath ("a/b/c") under
// parentID and returns the final folder. Get-or-create is idempotent: on a
// unique-constraint race the winner's row is re-selected. A path segment that
// exists as a FILE is a conflict (ErrDriveNameConflict) — auto-renaming would
// scatter one client directory across "dir"/"dir (1)" between calls.
func (s *DriveService) EnsureFolderPath(ctx context.Context, parentID *int64, relPath string) (*models.DriveNode, error) {
	const maxDepth = 32
	segs := make([]string, 0, 8)
	for _, seg := range strings.Split(filepath.ToSlash(relPath), "/") {
		seg = strings.TrimSpace(seg)
		if seg == "" {
			continue
		}
		if err := validName(seg); err != nil {
			return nil, err
		}
		segs = append(segs, seg)
	}
	if len(segs) == 0 || len(segs) > maxDepth {
		return nil, ErrDriveInvalidName
	}
	if parentID != nil {
		if _, err := s.requireActiveFolder(ctx, *parentID); err != nil {
			return nil, err
		}
	}

	cur := parentID
	var node *models.DriveNode
	for _, seg := range segs {
		n, err := s.getOrCreateFolder(ctx, cur, seg)
		if err != nil {
			return nil, err
		}
		node = n
		id := n.ID
		cur = &id
	}
	return node, nil
}

func (s *DriveService) getOrCreateFolder(ctx context.Context, parentID *int64, name string) (*models.DriveNode, error) {
	existing, err := s.FindActiveSibling(ctx, parentID, name)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		if existing.Type != "folder" {
			return nil, ErrDriveNameConflict
		}
		return existing, nil
	}
	n, err := s.CreateFolder(ctx, parentID, name)
	if err != nil {
		if errors.Is(err, ErrDriveNameConflict) {
			// A concurrent creator won the race — reuse their row.
			if again, err2 := s.FindActiveSibling(ctx, parentID, name); err2 == nil && again != nil && again.Type == "folder" {
				return again, nil
			}
		}
		return nil, err
	}
	return n, nil
}

// SetStarred stars (starred=true) or unstars the given active nodes. Starring
// is a metadata toggle — it deliberately does not bump updated_at so the
// "modified" sort stays stable.
func (s *DriveService) SetStarred(ctx context.Context, ids []int64, starred bool) error {
	if len(ids) == 0 {
		return nil
	}
	var val any
	if starred {
		val = time.Now().UnixMilli()
	}
	q, args, err := sqlx.In(
		`UPDATE drive_nodes SET starred_at = ? WHERE id IN (?) AND deleted_at IS NULL`, val, ids)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, s.db.Rebind(q), args...)
	return err
}

// ListStarred returns starred, non-deleted nodes (most recently starred
// first), with ancestor paths and share counts populated like search results.
func (s *DriveService) ListStarred(ctx context.Context) ([]models.DriveNode, error) {
	var out []models.DriveNode
	if err := s.db.SelectContext(ctx, &out, `
SELECT * FROM drive_nodes
WHERE starred_at IS NOT NULL AND deleted_at IS NULL
ORDER BY starred_at DESC, id DESC`); err != nil {
		return nil, err
	}
	if len(out) > 0 {
		if err := s.populatePaths(ctx, out); err != nil {
			return nil, err
		}
		if err := s.populateShareCounts(ctx, out); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// Usage reports drive storage consumption; see models.DriveUsage.
func (s *DriveService) Usage(ctx context.Context) (*models.DriveUsage, error) {
	var u models.DriveUsage
	if err := s.db.QueryRowxContext(ctx, `
SELECT COALESCE(SUM(size), 0), COUNT(*) FROM drive_nodes
WHERE type = 'file' AND deleted_at IS NULL`).Scan(&u.ActiveBytes, &u.ActiveCount); err != nil {
		return nil, err
	}
	if err := s.db.QueryRowxContext(ctx, `
SELECT COALESCE(SUM(size), 0), COUNT(*) FROM drive_nodes
WHERE type = 'file' AND deleted_at IS NOT NULL`).Scan(&u.TrashBytes, &u.TrashCount); err != nil {
		return nil, err
	}
	// Each distinct blob counted once — copies/deduplicated rows share blobs.
	if err := s.db.QueryRowxContext(ctx, `
SELECT COALESCE(SUM(sz), 0) FROM (
  SELECT MAX(size) AS sz FROM drive_nodes
  WHERE blob_path IS NOT NULL GROUP BY blob_path
)`).Scan(&u.PhysicalBytes); err != nil {
		return nil, err
	}
	// Free/total space on the filesystem backing the uploads dir (df-style).
	u.FreeBytes, u.TotalBytes = diskSpace(s.config.BasePath)
	return &u, nil
}

// diskSpace reports the available and total bytes on the filesystem that
// contains path (best-effort; returns 0, 0 on error). Unix only.
func diskSpace(path string) (free, total int64) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0
	}
	bs := uint64(st.Bsize)
	return int64(st.Bavail * bs), int64(st.Blocks * bs)
}
