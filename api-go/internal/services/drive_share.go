package services

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"github.com/cymoo/mote/internal/models"
	"github.com/jmoiron/sqlx"
	"golang.org/x/crypto/bcrypt"
)

var (
	ErrShareNotFound      = errors.New("share not found")
	ErrShareExpired       = errors.New("share expired")
	ErrShareWrongPassword = errors.New("wrong share password")
	ErrShareNoPassword    = errors.New("share has no password")
	ErrShareInvalidNode   = errors.New("only files can be shared")
)

// DriveShareService manages public file share links.
type DriveShareService struct {
	db    *sqlx.DB
	drive *DriveService
}

func NewDriveShareService(db *sqlx.DB, drive *DriveService) *DriveShareService {
	return &DriveShareService{db: db, drive: drive}
}

// Create issues a new share. The plaintext token is persisted so authenticated
// owners can view/copy existing share links later.
func (s *DriveShareService) Create(
	ctx context.Context, nodeID int64, password *string, expiresAt *int64,
) (*models.DriveShare, error) {
	n, err := s.drive.FindByID(ctx, nodeID)
	if err != nil {
		return nil, err
	}
	if n.Type != "file" {
		return nil, ErrShareInvalidNode
	}
	if n.DeletedAt.Valid {
		return nil, ErrDriveNotFound
	}

	token := newURLSafeToken(32)
	hash := sha256Hex(token)
	prefix := hash[:8]

	var pwHash sql.NullString
	if password != nil && *password != "" {
		h, err := bcrypt.GenerateFromPassword([]byte(*password), bcrypt.DefaultCost)
		if err != nil {
			return nil, err
		}
		pwHash = sql.NullString{Valid: true, String: string(h)}
	}

	var exp sql.NullInt64
	if expiresAt != nil && *expiresAt > 0 {
		exp = sql.NullInt64{Valid: true, Int64: *expiresAt}
	}

	now := time.Now().UnixMilli()
	var id int64
	err = s.db.QueryRowxContext(ctx, `
INSERT INTO drive_shares (node_id, token_hash, token_prefix, token, password_hash, expires_at, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
		nodeID, hash, prefix, token, pwHash, exp, now).Scan(&id)
	if err != nil {
		return nil, err
	}

	share, err := s.findByID(ctx, id)
	if err != nil {
		return nil, err
	}
	share.Token = token
	share.HasPassword = pwHash.Valid
	return share, nil
}

func (s *DriveShareService) findByID(ctx context.Context, id int64) (*models.DriveShare, error) {
	var sh models.DriveShare
	err := s.db.GetContext(ctx, &sh, `SELECT * FROM drive_shares WHERE id = ?`, id)
	if err == sql.ErrNoRows {
		return nil, ErrShareNotFound
	}
	if err != nil {
		return nil, err
	}
	sh.HasPassword = sh.PasswordHash.Valid
	return &sh, nil
}

// ListByNode returns all shares for a given file node.
func (s *DriveShareService) ListByNode(ctx context.Context, nodeID int64) ([]models.DriveShare, error) {
	var out []models.DriveShare
	if err := s.db.SelectContext(ctx, &out,
		`SELECT * FROM drive_shares WHERE node_id = ? ORDER BY created_at DESC`,
		nodeID); err != nil {
		return nil, err
	}
	for i := range out {
		out[i].HasPassword = out[i].PasswordHash.Valid
	}
	return out, nil
}

// Revoke deletes a share by id.
func (s *DriveShareService) Revoke(ctx context.Context, id int64) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM drive_shares WHERE id = ?`, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrShareNotFound
	}
	return nil
}

// Resolve looks up a share by its plaintext token.
// It returns the share and the file node, validating expiry.
// It does NOT check password — callers must call VerifyPassword.
func (s *DriveShareService) Resolve(ctx context.Context, token string) (*models.DriveShare, *models.DriveNode, error) {
	if token == "" {
		return nil, nil, ErrShareNotFound
	}
	hash := sha256Hex(token)
	prefix := hash[:8]

	// Use the prefix index, then constant-time compare each candidate's full hash.
	var rows []models.DriveShare
	if err := s.db.SelectContext(ctx, &rows,
		`SELECT * FROM drive_shares WHERE token_prefix = ?`, prefix); err != nil {
		return nil, nil, err
	}
	var match *models.DriveShare
	for i := range rows {
		if subtle.ConstantTimeCompare([]byte(rows[i].TokenHash), []byte(hash)) == 1 {
			match = &rows[i]
			break
		}
	}
	if match == nil {
		return nil, nil, ErrShareNotFound
	}
	match.HasPassword = match.PasswordHash.Valid

	if match.ExpiresAt.Valid && match.ExpiresAt.Int64 < time.Now().UnixMilli() {
		return nil, nil, ErrShareExpired
	}

	node, err := s.drive.FindByID(ctx, match.NodeID)
	if err != nil {
		return nil, nil, err
	}
	if node.DeletedAt.Valid || node.Type != "file" {
		return nil, nil, ErrShareNotFound
	}
	return match, node, nil
}

// VerifyPassword returns nil on success, or an error.
func (s *DriveShareService) VerifyPassword(share *models.DriveShare, password string) error {
	if !share.PasswordHash.Valid {
		return ErrShareNoPassword
	}
	if err := bcrypt.CompareHashAndPassword(
		[]byte(share.PasswordHash.String), []byte(password),
	); err != nil {
		return ErrShareWrongPassword
	}
	return nil
}

// ListAll returns all shares (optionally including expired ones), each
// joined with the file's name + size and the parent path. Used by the
// global "Shared" view. Shares whose underlying file has been
// soft-deleted are excluded — they are unreachable anyway.
func (s *DriveShareService) ListAll(ctx context.Context, includeExpired bool) ([]models.ShareWithNode, error) {
	q := `
SELECT s.*, n.name AS name, COALESCE(n.size, 0) AS size, n.parent_id AS node_parent_id
FROM drive_shares s
JOIN drive_nodes n ON n.id = s.node_id
WHERE n.deleted_at IS NULL`
	if !includeExpired {
		q += ` AND (s.expires_at IS NULL OR s.expires_at > ?)`
	}
	q += ` ORDER BY s.created_at DESC`

	type row struct {
		models.DriveShare
		Name         string           `db:"name"`
		Size         int64            `db:"size"`
		NodeParentID models.NullInt64 `db:"node_parent_id"`
	}
	var rows []row
	var err error
	if includeExpired {
		err = s.db.SelectContext(ctx, &rows, q)
	} else {
		err = s.db.SelectContext(ctx, &rows, q, time.Now().UnixMilli())
	}
	if err != nil {
		return nil, err
	}

	out := make([]models.ShareWithNode, 0, len(rows))
	pathCache := map[int64]string{}
	for i := range rows {
		r := &rows[i]
		r.HasPassword = r.PasswordHash.Valid
		path := ""
		if r.NodeParentID.Valid {
			if p, ok := pathCache[r.NodeParentID.Int64]; ok {
				path = p
			} else {
				bcs, err := s.drive.Breadcrumbs(ctx, r.NodeParentID.Int64)
				if err != nil {
					return nil, err
				}
				parts := make([]string, 0, len(bcs))
				for _, bc := range bcs {
					parts = append(parts, bc.Name)
				}
				path = strings.Join(parts, "/")
				pathCache[r.NodeParentID.Int64] = path
			}
		}
		out = append(out, models.ShareWithNode{
			DriveShare: r.DriveShare,
			Name:       r.Name,
			Size:       r.Size,
			ParentID:   r.NodeParentID,
			Path:       path,
		})
	}
	return out, nil
}

// PurgeExpired deletes share rows whose expiry has passed. Returns the
// number of rows deleted.
func (s *DriveShareService) PurgeExpired(ctx context.Context) (int64, error) {
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM drive_shares WHERE expires_at IS NOT NULL AND expires_at <= ?`,
		time.Now().UnixMilli())
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}

func newURLSafeToken(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return strings.TrimRight(base64.URLEncoding.EncodeToString(b), "=")
}

func sha256Hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}
