package services

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/cymoo/mote/internal/config"
	"github.com/cymoo/mote/internal/models"
	"github.com/jmoiron/sqlx"
)

const (
	driveUploadTTL    = 24 * time.Hour
	maxFileSize       = int64(4 << 30) // 4 GB
	defaultChunkSize  = int64(8 << 20) // 8 MB
)

var (
	ErrUploadNotFound       = errors.New("upload session not found or expired")
	ErrUploadChunkSize      = errors.New("chunk size mismatch")
	ErrUploadChunkOOR       = errors.New("chunk index out of range")
	ErrUploadIncomplete     = errors.New("upload is incomplete")
	ErrUploadFinalSize      = errors.New("final file size mismatch")
	ErrUploadTooLarge       = errors.New("file too large")
	ErrUploadInvalidRequest = errors.New("invalid upload request")
)

// DriveUploadService handles chunked, resumable uploads.
type DriveUploadService struct {
	db     *sqlx.DB
	drive  *DriveService
	config *config.UploadConfig
}

func NewDriveUploadService(db *sqlx.DB, drive *DriveService, cfg *config.UploadConfig) *DriveUploadService {
	return &DriveUploadService{db: db, drive: drive, config: cfg}
}

func (s *DriveUploadService) chunksDir(uploadID string) string {
	return filepath.Join(s.config.BasePath, "drive", "_chunks", uploadID)
}

// Init creates a new upload session.
func (s *DriveUploadService) Init(ctx context.Context, req models.DriveUploadInitRequest) (*models.DriveUpload, error) {
	if err := validName(req.Name); err != nil {
		return nil, err
	}
	if req.Size <= 0 || req.Size > maxFileSize {
		return nil, ErrUploadTooLarge
	}
	chunk := req.ChunkSize
	if chunk <= 0 {
		chunk = defaultChunkSize
	}
	if chunk < 1<<20 || chunk > 64<<20 {
		return nil, ErrUploadInvalidRequest
	}
	if req.ParentID != nil {
		if _, err := s.drive.requireActiveFolder(ctx, *req.ParentID); err != nil {
			return nil, err
		}
	}

	total := int((req.Size + chunk - 1) / chunk)
	mask := make([]byte, (total+7)/8)

	id := newToken(16)
	now := time.Now().UnixMilli()
	expiresAt := now + driveUploadTTL.Milliseconds()

	if err := os.MkdirAll(s.chunksDir(id), 0755); err != nil {
		return nil, err
	}

	_, err := s.db.ExecContext(ctx, `
INSERT INTO drive_uploads (id, parent_id, name, size, chunk_size, total_chunks, received_mask, status, expires_at, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?, ?)`,
		id, req.ParentID, req.Name, req.Size, chunk, total, mask, expiresAt, now, now)
	if err != nil {
		_ = os.RemoveAll(s.chunksDir(id))
		return nil, err
	}

	return s.find(ctx, id)
}

func (s *DriveUploadService) find(ctx context.Context, id string) (*models.DriveUpload, error) {
	var u models.DriveUpload
	err := s.db.GetContext(ctx, &u, `SELECT * FROM drive_uploads WHERE id = ?`, id)
	if err == sql.ErrNoRows {
		return nil, ErrUploadNotFound
	}
	if err != nil {
		return nil, err
	}
	if u.ExpiresAt < time.Now().UnixMilli() {
		return nil, ErrUploadNotFound
	}
	return &u, nil
}

// Get returns a session and the list of received chunk indices.
func (s *DriveUploadService) Get(ctx context.Context, id string) (*models.DriveUpload, []int, error) {
	u, err := s.find(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	return u, decodeMask(u.ReceivedMask, u.TotalChunks), nil
}

// PutChunk writes a single chunk idempotently.
func (s *DriveUploadService) PutChunk(ctx context.Context, id string, idx int, body io.Reader) error {
	u, err := s.find(ctx, id)
	if err != nil {
		return err
	}
	if u.Status != "uploading" {
		return ErrUploadInvalidRequest
	}
	if idx < 0 || idx >= u.TotalChunks {
		return ErrUploadChunkOOR
	}

	expected := u.ChunkSize
	if idx == u.TotalChunks-1 {
		// last chunk may be smaller
		expected = u.Size - int64(idx)*u.ChunkSize
	}

	tmp := filepath.Join(s.chunksDir(id), fmt.Sprintf("%d.part", idx))
	final := filepath.Join(s.chunksDir(id), fmt.Sprintf("%d.bin", idx))

	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	written, err := io.CopyN(f, body, expected+1) // read one extra to detect oversize
	if err != nil && err != io.EOF {
		f.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if written != expected {
		_ = os.Remove(tmp)
		return ErrUploadChunkSize
	}
	if err := os.Rename(tmp, final); err != nil {
		_ = os.Remove(tmp)
		return err
	}

	// Update bitmap atomically. We use BEGIN IMMEDIATE to acquire the
	// reserved lock up-front: a deferred transaction (the default) starts
	// with a SHARED lock on SELECT and then upgrades on UPDATE, which can
	// deadlock when multiple chunk uploads race for the same row and one
	// returns SQLITE_BUSY despite busy_timeout.
	conn, err := s.db.Connx(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_, _ = conn.ExecContext(context.Background(), "ROLLBACK")
		}
	}()
	var mask []byte
	if err := conn.GetContext(ctx, &mask, `SELECT received_mask FROM drive_uploads WHERE id = ?`, id); err != nil {
		return err
	}
	if idx/8 >= len(mask) {
		return ErrUploadInvalidRequest
	}
	mask[idx/8] |= 1 << (idx % 8)
	now := time.Now().UnixMilli()
	if _, err := conn.ExecContext(ctx,
		`UPDATE drive_uploads SET received_mask = ?, updated_at = ? WHERE id = ?`,
		mask, now, id); err != nil {
		return err
	}
	if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
		return err
	}
	committed = true
	return nil
}

// Complete assembles all chunks into the final blob and inserts a drive_nodes row.
// onCollision: "ask" (default; returns ErrDriveNameConflict on conflict),
// "overwrite", "rename", or "skip".
// On "skip" with collision, returns the existing node and discards the upload.
func (s *DriveUploadService) Complete(
	ctx context.Context, id string, onCollision string,
) (*models.DriveNode, error) {
	u, err := s.find(ctx, id)
	if err != nil {
		return nil, err
	}
	// Only one assemble at a time per session.
	res, err := s.db.ExecContext(ctx,
		`UPDATE drive_uploads SET status = 'assembling', updated_at = ?
		 WHERE id = ? AND status = 'uploading'`,
		time.Now().UnixMilli(), id)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, ErrUploadInvalidRequest
	}
	defer func() {
		// On error, allow the client to retry.
		if r := recover(); r != nil {
			if _, err := s.db.ExecContext(context.Background(),
				`UPDATE drive_uploads SET status = 'uploading' WHERE id = ?`, id); err != nil {
				log.Printf("drive upload: revert status after panic failed: %v", err)
			}
			panic(r)
		}
	}()

	// Verify all chunks present.
	var mask []byte
	if err := s.db.GetContext(ctx, &mask, `SELECT received_mask FROM drive_uploads WHERE id = ?`, id); err != nil {
		s.markUploading(id)
		return nil, err
	}
	if len(mask)*8 < u.TotalChunks {
		s.markUploading(id)
		return nil, ErrUploadInvalidRequest
	}
	for i := 0; i < u.TotalChunks; i++ {
		if mask[i/8]&(1<<(i%8)) == 0 {
			s.markUploading(id)
			return nil, ErrUploadIncomplete
		}
	}

	// Pre-collision check (fast path for skip/rename without writing the blob to drive/).
	var parentID *int64
	if u.ParentID.Valid {
		v := u.ParentID.Int64
		parentID = &v
	}
	// Re-validate parent: it may have been (soft-)deleted between Init and now.
	if parentID != nil {
		if _, err := s.drive.requireActiveFolder(ctx, *parentID); err != nil {
			s.markUploading(id)
			return nil, err
		}
	}
	finalName := u.Name
	if existing, err := s.drive.FindActiveSibling(ctx, parentID, finalName); err != nil {
		s.markUploading(id)
		return nil, err
	} else if existing != nil {
		switch onCollision {
		case "skip":
			_ = s.deleteSession(id)
			return existing, nil
		case "rename":
			finalName, err = s.drive.AutoRename(ctx, parentID, finalName)
			if err != nil {
				s.markUploading(id)
				return nil, err
			}
		case "overwrite":
			// fall through; ReplaceFileNode handles it.
		default: // "ask" or empty
			s.markUploading(id)
			return nil, ErrDriveNameConflict
		}
	}

	// Assemble into a temp file inside drive/, then rename.
	blobName := newBlobName(finalName)
	relPath := filepath.Join("drive", blobName)
	absPath := filepath.Join(s.config.BasePath, relPath)
	tmpAbs := absPath + ".part"

	hash, written, err := s.assemble(u, tmpAbs)
	if err != nil {
		_ = os.Remove(tmpAbs)
		s.markUploading(id)
		return nil, err
	}
	if written != u.Size {
		_ = os.Remove(tmpAbs)
		s.markUploading(id)
		return nil, ErrUploadFinalSize
	}
	if err := os.Rename(tmpAbs, absPath); err != nil {
		_ = os.Remove(tmpAbs)
		s.markUploading(id)
		return nil, err
	}

	var node *models.DriveNode
	if onCollision == "overwrite" {
		node, err = s.drive.ReplaceFileNode(ctx, parentID, finalName, relPath, hash, u.Size)
	} else {
		node, err = s.drive.CreateFileNode(ctx, parentID, finalName, relPath, hash, u.Size)
	}
	if err != nil {
		_ = os.Remove(absPath)
		s.markUploading(id)
		return nil, err
	}

	_ = s.deleteSession(id)
	return node, nil
}

// Cancel aborts a session and removes its chunks. It only operates on
// 'uploading' sessions to avoid racing the assemble phase of Complete.
func (s *DriveUploadService) Cancel(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM drive_uploads WHERE id = ? AND status = 'uploading'`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		// Either gone already, or in 'assembling' — leave Complete to finish.
		return nil
	}
	return os.RemoveAll(s.chunksDir(id))
}

// PurgeExpired removes upload sessions past their expires_at.
func (s *DriveUploadService) PurgeExpired(ctx context.Context) (int, error) {
	now := time.Now().UnixMilli()
	var ids []string
	if err := s.db.SelectContext(ctx, &ids,
		`SELECT id FROM drive_uploads WHERE expires_at < ?`, now); err != nil {
		return 0, err
	}
	for _, id := range ids {
		_ = s.deleteSession(id)
	}
	return len(ids), nil
}

func (s *DriveUploadService) deleteSession(id string) error {
	_, _ = s.db.Exec(`DELETE FROM drive_uploads WHERE id = ?`, id)
	return os.RemoveAll(s.chunksDir(id))
}

func (s *DriveUploadService) markUploading(id string) {
	s.db.Exec(`UPDATE drive_uploads SET status = 'uploading' WHERE id = ?`, id)
}

// assemble concatenates chunk files into outPath while computing sha256.
func (s *DriveUploadService) assemble(u *models.DriveUpload, outPath string) (string, int64, error) {
	out, err := os.Create(outPath)
	if err != nil {
		return "", 0, err
	}
	defer out.Close()

	h := sha256.New()
	mw := io.MultiWriter(out, h)

	var total int64
	for i := 0; i < u.TotalChunks; i++ {
		path := filepath.Join(s.chunksDir(u.ID), fmt.Sprintf("%d.bin", i))
		f, err := os.Open(path)
		if err != nil {
			return "", 0, err
		}
		n, err := io.Copy(mw, f)
		f.Close()
		if err != nil {
			return "", 0, err
		}
		total += n
	}
	if err := out.Sync(); err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), total, nil
}

func decodeMask(mask []byte, total int) []int {
	out := make([]int, 0, total)
	for i := 0; i < total; i++ {
		if i/8 >= len(mask) {
			break
		}
		if mask[i/8]&(1<<(i%8)) != 0 {
			out = append(out, i)
		}
	}
	return out
}
