package tasks

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/cymoo/mita"
	"github.com/jmoiron/sqlx"
)

// PurgeExpiredDriveUploads removes drive_uploads rows whose expires_at has passed
// and deletes their on-disk chunk directories.
func PurgeExpiredDriveUploads(ctx context.Context) error {
	db := ctx.Value(mita.CtxtKey("db")).(*sqlx.DB)
	uploadPath := ctx.Value(mita.CtxtKey("upload_path")).(string)

	now := time.Now().UnixMilli()
	var ids []string
	if err := db.SelectContext(ctx, &ids,
		`SELECT id FROM drive_uploads WHERE expires_at < ?`, now); err != nil {
		return fmt.Errorf("listing expired uploads: %w", err)
	}
	for _, id := range ids {
		_, _ = db.ExecContext(ctx, `DELETE FROM drive_uploads WHERE id = ?`, id)
		_ = os.RemoveAll(filepath.Join(uploadPath, "drive", "_chunks", id))
	}
	if len(ids) > 0 {
		log.Printf("[Daily] purged %d expired drive uploads", len(ids))
	}
	return nil
}

// PurgeExpiredDriveShares deletes drive_shares rows whose expires_at has
// passed. Active shares (NULL expiry) are kept indefinitely.
func PurgeExpiredDriveShares(ctx context.Context) error {
	db := ctx.Value(mita.CtxtKey("db")).(*sqlx.DB)
	res, err := db.ExecContext(ctx,
		`DELETE FROM drive_shares WHERE expires_at IS NOT NULL AND expires_at <= ?`,
		time.Now().UnixMilli())
	if err != nil {
		return fmt.Errorf("purging expired drive shares: %w", err)
	}
	if n, _ := res.RowsAffected(); n > 0 {
		log.Printf("[Hourly] purged %d expired drive shares", n)
	}
	return nil
}

// PurgeOldDriveTrash hard-deletes drive_nodes that have been in the recycle bin
// for longer than 30 days and removes their blob files.
func PurgeOldDriveTrash(ctx context.Context) error {
	db := ctx.Value(mita.CtxtKey("db")).(*sqlx.DB)
	uploadPath := ctx.Value(mita.CtxtKey("upload_path")).(string)

	cutoff := time.Now().UTC().AddDate(0, 0, -30).UnixMilli()

	type row struct {
		ID       int64  `db:"id"`
		BlobPath string `db:"blob_path"`
	}

	// Collect every (deleted-batch root + descendants) blob path before deletion.
	var rows []row
	q := `
WITH RECURSIVE trash(id) AS (
  SELECT id FROM drive_nodes
  WHERE deleted_at IS NOT NULL AND deleted_at < ?
    AND (
      parent_id IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM drive_nodes p
        WHERE p.id = drive_nodes.parent_id
          AND p.deleted_at IS NOT NULL
          AND p.delete_batch_id = drive_nodes.delete_batch_id
      )
    )
  UNION ALL
  SELECT n.id FROM drive_nodes n JOIN trash t ON n.parent_id = t.id
)
SELECT n.id, COALESCE(n.blob_path, '') AS blob_path
FROM drive_nodes n WHERE n.id IN (SELECT id FROM trash)`
	if err := db.SelectContext(ctx, &rows, q, cutoff); err != nil {
		return fmt.Errorf("listing old trash: %w", err)
	}
	if len(rows) == 0 {
		return nil
	}

	// Delete the batch roots (cascades).
	res, err := db.ExecContext(ctx, `
DELETE FROM drive_nodes
WHERE deleted_at IS NOT NULL AND deleted_at < ?
  AND (
    parent_id IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM drive_nodes p
      WHERE p.id = drive_nodes.parent_id
        AND p.deleted_at IS NOT NULL
        AND p.delete_batch_id = drive_nodes.delete_batch_id
    )
  )`, cutoff)
	if err != nil {
		return fmt.Errorf("deleting old trash: %w", err)
	}

	for _, r := range rows {
		if r.BlobPath != "" {
			_ = os.Remove(filepath.Join(uploadPath, r.BlobPath))
		}
	}
	n, _ := res.RowsAffected()
	if n > 0 {
		log.Printf("[Daily] purged %d drive nodes from trash", n)
	}
	return nil
}
