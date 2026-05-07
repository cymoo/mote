package services

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/cymoo/mote/internal/models"
	"github.com/jmoiron/sqlx"
)

var (
	ErrPostNotFound = errors.New("post not found")
	hashTagRegex    = regexp.MustCompile(`<span class="hash-tag">#(.+?)</span>`)
)

type PostService struct {
	db *sqlx.DB
}

func NewPostService(db *sqlx.DB) *PostService {
	return &PostService{db: db}
}

// FindWithParent retrieves a post with its parent
func (s *PostService) FindWithParent(ctx context.Context, id int64) (*models.Post, error) {
	query := `
		WITH target AS (
			SELECT *
			FROM posts
			WHERE id = ? AND deleted_at IS NULL
		)
		SELECT * FROM target
		UNION ALL
		SELECT parent.*
		FROM posts AS parent
		INNER JOIN target ON parent.id = target.parent_id
		WHERE parent.deleted_at IS NULL
	`

	var rows []models.Post
	if err := s.db.SelectContext(ctx, &rows, query, id); err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, ErrPostNotFound
	}

	var post *models.Post
	parents := make(map[int64]*models.Post, len(rows)-1)
	for i := range rows {
		rows[i].Tags = []string{}
		if rows[i].ID == id {
			post = &rows[i]
			continue
		}
		parents[rows[i].ID] = &rows[i]
	}
	if post == nil {
		return nil, ErrPostNotFound
	}
	if post.ParentID.Valid {
		post.Parent = parents[post.ParentID.Int64]
	}

	return post, nil
}

// FindByID retrieves a post by its ID
func (s *PostService) FindByID(ctx context.Context, id int64) (*models.Post, error) {
	query := `SELECT * FROM posts WHERE id = ? AND deleted_at IS NULL`

	var post models.Post
	err := s.db.GetContext(ctx, &post, query, id)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	post.Tags = []string{}
	return &post, nil
}

// FindByIDs retrieves multiple posts by their IDs
func (s *PostService) FindByIDs(ctx context.Context, ids []int64) ([]models.Post, error) {
	if len(ids) == 0 {
		return []models.Post{}, nil
	}

	idsJSON, _ := json.Marshal(ids)
	query := `
		SELECT *
		FROM posts
		WHERE id IN (SELECT value FROM json_each(?))
		AND deleted_at IS NULL
	`

	posts := []models.Post{}
	err := s.db.SelectContext(ctx, &posts, query, string(idsJSON))
	if err != nil {
		return nil, err
	}

	if err := s.attachParents(ctx, posts); err != nil {
		return nil, err
	}

	if err := s.attachTags(ctx, posts); err != nil {
		return nil, err
	}

	return posts, nil
}

// GetCount returns the total count of non-deleted posts
func (s *PostService) GetCount(ctx context.Context) (int64, error) {
	query := `SELECT COUNT(*) FROM posts WHERE deleted_at IS NULL`

	var count int64
	err := s.db.GetContext(ctx, &count, query)
	return count, err
}

// GetActiveDays returns the count of distinct days with posts
func (s *PostService) GetActiveDays(ctx context.Context) (int64, error) {
	query := `
		SELECT COUNT(DISTINCT date(created_at / 1000, 'unixepoch'))
		FROM posts
		WHERE deleted_at IS NULL
	`

	var count int64
	err := s.db.GetContext(ctx, &count, query)
	return count, err
}

// GetDailyCounts returns daily post counts within a date range
func (s *PostService) GetDailyCounts(ctx context.Context, startDate, endDate time.Time, offsetSeconds int) ([]int64, error) {
	offsetMs := int64(offsetSeconds) * 1000
	startTs := startDate.UnixMilli()
	endTs := endDate.UnixMilli()
	dayMs := int64(3600 * 24 * 1000)

	query := `
		SELECT (created_at + ?) / ? as local_day, COUNT(*) as count
		FROM posts
		WHERE deleted_at IS NULL
			AND created_at BETWEEN ? AND ?
		GROUP BY local_day
		ORDER BY local_day
	`

	type dayCount struct {
		LocalDay int64 `db:"local_day"`
		Count    int64 `db:"count"`
	}

	var results []dayCount
	err := s.db.SelectContext(ctx, &results, query, offsetMs, dayMs, startTs, endTs)
	if err != nil {
		return nil, err
	}

	// Create map for quick lookup
	countMap := make(map[int64]int64)
	for _, r := range results {
		countMap[r.LocalDay] = r.Count
	}

	// Calculate range and fill missing days with 0
	days := (endDate.Sub(startDate).Hours() / 24) + 1
	startDay := (startTs + offsetMs) / dayMs
	endDay := startDay + int64(days) - 1

	counts := make([]int64, 0, int(days))
	for day := startDay; day <= endDay; day++ {
		counts = append(counts, countMap[day])
	}

	return counts, nil
}

// Filter retrieves posts based on filter options
func (s *PostService) Filter(ctx context.Context, options models.FilterPostRequest, perPage int) ([]models.Post, error) {
	var args []interface{}
	var conditions []string

	// Base query with optional tag join
	var baseQuery string
	if options.Tag != nil {
		baseQuery = `
			SELECT DISTINCT p.* FROM posts p
			INNER JOIN tag_post_assoc tp ON p.id = tp.post_id
			INNER JOIN tags t ON tp.tag_id = t.id
		`
		conditions = append(conditions, "(t.name = ? OR t.name LIKE ?)")
		args = append(args, *options.Tag, *options.Tag+"/%")
	} else {
		baseQuery = "SELECT p.* FROM posts p"
	}

	// Deleted filter
	if options.Deleted {
		conditions = append(conditions, "p.deleted_at IS NOT NULL")
	} else {
		conditions = append(conditions, "p.deleted_at IS NULL")
	}

	// Parent ID filter
	if options.ParentID != nil {
		conditions = append(conditions, "p.parent_id = ?")
		args = append(args, *options.ParentID)
	}

	// Color filter
	if options.Color != nil {
		conditions = append(conditions, "p.color = ?")
		args = append(args, *options.Color)
	}

	// Date range filters
	if options.StartDate != nil {
		conditions = append(conditions, "p.created_at >= ?")
		args = append(args, *options.StartDate)
	}
	if options.EndDate != nil {
		conditions = append(conditions, "p.created_at <= ?")
		args = append(args, *options.EndDate)
	}

	// Shared filter
	if options.Shared != nil {
		conditions = append(conditions, "p.shared = ?")
		args = append(args, *options.Shared)
	}

	// Files filter
	if options.HasFiles != nil {
		if *options.HasFiles {
			conditions = append(conditions, "p.files IS NOT NULL")
		} else {
			conditions = append(conditions, "p.files IS NULL")
		}
	}

	// Build WHERE clause
	whereClause := ""
	if len(conditions) > 0 {
		whereClause = " WHERE " + strings.Join(conditions, " AND ")
	}

	// Order field
	orderBy := "p.created_at"
	if options.OrderBy != "" {
		orderBy = "p." + options.OrderBy
	}

	// Cursor pagination
	if options.Cursor != nil {
		operator := "<"
		if options.Ascending {
			operator = ">"
		}
		whereClause += fmt.Sprintf(" AND %s %s ?", orderBy, operator)
		args = append(args, *options.Cursor)
	}

	// Direction
	direction := "DESC"
	if options.Ascending {
		direction = "ASC"
	}

	// Final query
	query := fmt.Sprintf("%s%s ORDER BY %s %s LIMIT %d",
		baseQuery, whereClause, orderBy, direction, perPage)
	posts := make([]models.Post, 0)

	err := s.db.SelectContext(ctx, &posts, query, args...)

	if err != nil {
		return nil, err
	}

	if err := s.attachParents(ctx, posts); err != nil {
		return nil, err
	}

	if err := s.attachTags(ctx, posts); err != nil {
		return nil, err
	}

	return posts, nil
}

// Create creates a new post
// It also extracts hashtags and creates tag associations
// Returns the created post's ID and timestamps
func (s *PostService) Create(ctx context.Context, req models.CreatePostRequest) (*models.CreateResponse, error) {
	now := time.Now().UnixMilli()

	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	// Prepare files JSON
	var filesJSON sql.NullString
	if len(req.Files) > 0 {
		filesBytes, _ := json.Marshal(req.Files)
		filesJSON = sql.NullString{String: string(filesBytes), Valid: true}
	}

	// Prepare optional fields
	shared := false
	if req.Shared != nil {
		shared = *req.Shared
	}

	var color models.NullString
	if req.Color != nil {
		color = models.NullString{NullString: sql.NullString{String: *req.Color, Valid: true}}
	}

	var parentID models.NullInt64
	if req.ParentID != nil {
		parentID = models.NullInt64{NullInt64: sql.NullInt64{Int64: *req.ParentID, Valid: true}}
	}

	// Insert post
	query := `
		INSERT INTO posts (content, files, color, shared, parent_id, created_at, updated_at, children_count)
		VALUES (?, ?, ?, ?, ?, ?, ?, 0)
	`

	result, err := tx.ExecContext(ctx, query, req.Content, filesJSON, color, shared, parentID, now, now)
	if err != nil {
		return nil, err
	}

	postID, err := result.LastInsertId()
	if err != nil {
		return nil, err
	}

	// Extract and create tags
	hashTags := extractHashTags(req.Content)
	tagService := NewTagService(s.db)

	for tagName := range hashTags {
		tag, err := tagService.findOrCreate(ctx, tx, tagName)
		if err != nil {
			return nil, err
		}

		_, err = tx.ExecContext(ctx,
			"INSERT INTO tag_post_assoc (post_id, tag_id) VALUES (?, ?)",
			postID, tag.ID)
		if err != nil {
			return nil, err
		}
	}

	// Update parent children count
	if req.ParentID != nil {
		if err := s.updateChildrenCount(ctx, tx, *req.ParentID, true); err != nil {
			return nil, err
		}
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}

	return &models.CreateResponse{
		ID:        postID,
		CreatedAt: now,
		UpdatedAt: now,
	}, nil
}

// Update updates an existing post
// It also updates tag associations if the content changes
// It updates the parent children counts if the parent_id changes
func (s *PostService) Update(ctx context.Context, req models.UpdatePostRequest) error {
	now := time.Now().UnixMilli()

	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Get old parent_id if parent_id is being updated
	var oldParentID models.NullInt64
	// if req.ParentID != nil {
	if req.ParentID.IsPresent() {
		err := tx.GetContext(ctx, &oldParentID,
			"SELECT parent_id FROM posts WHERE id = ?", req.ID)
		if err == sql.ErrNoRows {
			return ErrPostNotFound
		}
		if err != nil {
			return err
		}
	}

	// Build update query dynamically
	updates := []string{"updated_at = ?"}
	args := []interface{}{now}

	if req.Content != nil {
		updates = append(updates, "content = ?")
		args = append(args, *req.Content)
	}
	if req.Shared != nil {
		updates = append(updates, "shared = ?")
		args = append(args, *req.Shared)
	}
	// if req.ParentID != nil {
	// 	updates = append(updates, "parent_id = ?")
	// 	if *req.ParentID == 0 {
	// 		args = append(args, nil)
	// 	} else {
	// 		args = append(args, *req.ParentID)
	// 	}
	// }
	// if req.Files != nil {
	// 	if *req.Files == nil {
	// 		updates = append(updates, "files = NULL")
	// 	} else {
	// 		filesBytes, _ := json.Marshal(*req.Files)
	// 		updates = append(updates, "files = ?")
	// 		args = append(args, string(filesBytes))
	// 	}
	// }
	// if req.Color != nil {
	// 	if *req.Color == "" {
	// 		updates = append(updates, "color = NULL")
	// 	} else {
	// 		updates = append(updates, "color = ?")
	// 		args = append(args, *req.Color)
	// 	}
	// }

	if req.ParentID.IsPresent() {
		updates = append(updates, "parent_id = ?")
		if req.ParentID.IsNull() {
			args = append(args, nil)
		} else {
			args = append(args, req.ParentID.MustGet())
		}
	}

	if req.Files.IsPresent() {
		if req.Files.IsNull() {
			updates = append(updates, "files = NULL")
		} else {
			filesBytes, _ := json.Marshal(req.Files.MustGet())
			updates = append(updates, "files = ?")
			args = append(args, string(filesBytes))
		}
	}

	if req.Color.IsPresent() {
		if req.Color.IsNull() {
			updates = append(updates, "color = NULL")
		} else {
			updates = append(updates, "color = ?")
			args = append(args, req.Color.MustGet())
		}
	}

	args = append(args, req.ID)
	query := fmt.Sprintf("UPDATE posts SET %s WHERE id = ?",
		strings.Join(updates, ", "))

	_, err = tx.ExecContext(ctx, query, args...)
	if err != nil {
		return err
	}

	// Update parent children counts
	// if req.ParentID != nil {
	if req.ParentID.IsPresent() {
		if oldParentID.Valid {
			if err := s.updateChildrenCount(ctx, tx, oldParentID.Int64, false); err != nil {
				return err
			}
		}
		// if *req.ParentID != 0 {
		if !req.ParentID.IsNull() {
			if err := s.updateChildrenCount(ctx, tx, req.ParentID.MustGet(), true); err != nil {
				return err
			}
		}
	}

	// Update tags if content changed
	if req.Content != nil {
		hashTags := extractHashTags(*req.Content)
		tagService := NewTagService(s.db)

		// Remove old associations
		_, err = tx.ExecContext(ctx, "DELETE FROM tag_post_assoc WHERE post_id = ?", req.ID)
		if err != nil {
			return err
		}

		// Add new associations
		for tagName := range hashTags {
			tag, err := tagService.findOrCreate(ctx, tx, tagName)
			if err != nil {
				return err
			}

			_, err = tx.ExecContext(ctx,
				"INSERT INTO tag_post_assoc (post_id, tag_id) VALUES (?, ?)",
				req.ID, tag.ID)
			if err != nil {
				return err
			}
		}
	}

	return tx.Commit()
}

// Delete soft deletes a post
// It sets the deleted_at timestamp and updates parent children count
func (s *PostService) Delete(ctx context.Context, id int64) error {
	now := time.Now().UnixMilli()

	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var post models.Post
	query := `UPDATE posts SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL RETURNING *`
	err = tx.GetContext(ctx, &post, query, now, id)
	if err == sql.ErrNoRows {
		return ErrPostNotFound
	}
	if err != nil {
		return err
	}

	if post.ParentID.Valid {
		if err := s.updateChildrenCount(ctx, tx, post.ParentID.Int64, false); err != nil {
			return err
		}
	}

	return tx.Commit()
}

// Restore restores a soft-deleted post
// It clears the deleted_at timestamp and updates parent children count
func (s *PostService) Restore(ctx context.Context, id int64) error {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var post models.Post
	query := `UPDATE posts SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL RETURNING *`
	err = tx.GetContext(ctx, &post, query, id)
	if err == sql.ErrNoRows {
		return ErrPostNotFound
	}
	if err != nil {
		return err
	}

	if post.ParentID.Valid {
		if err := s.updateChildrenCount(ctx, tx, post.ParentID.Int64, true); err != nil {
			return err
		}
	}

	return tx.Commit()
}

// HardDelete permanently deletes a post
// It only deletes posts that are already soft-deleted
func (s *PostService) HardDelete(ctx context.Context, id int64) error {
	query := `DELETE FROM posts WHERE id = ? AND deleted_at IS NOT NULL`
	_, err := s.db.ExecContext(ctx, query, id)
	return err
}

// ClearAll permanently deletes all soft-deleted posts
// It returns the IDs of the deleted posts
func (s *PostService) ClearAll(ctx context.Context) ([]int64, error) {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	query := `DELETE FROM posts WHERE deleted_at IS NOT NULL RETURNING id`

	var ids []int64
	if err := tx.SelectContext(ctx, &ids, query); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return ids, nil
}

// Helper functions

// updateChildrenCount updates the children_count of a parent post
// If increment is true, it increments the count; otherwise, it decrements it
func (s *PostService) updateChildrenCount(ctx context.Context, tx *sqlx.Tx, parentID int64, increment bool) error {
	query := "UPDATE posts SET children_count = children_count - 1 WHERE id = ?"
	if increment {
		query = "UPDATE posts SET children_count = children_count + 1 WHERE id = ?"
	}

	_, err := tx.ExecContext(ctx, query, parentID)
	return err
}

// attachTags attaches tags to the given posts
// It modifies the posts slice in place
func (s *PostService) attachTags(ctx context.Context, posts []models.Post) error {
	if len(posts) == 0 {
		return nil
	}

	postIDs := make([]int64, len(posts))
	for i, post := range posts {
		postIDs[i] = post.ID
	}

	idsJSON, _ := json.Marshal(postIDs)
	query := `
		SELECT tp.post_id, tags.name as tag_name
		FROM tag_post_assoc as tp
		INNER JOIN tags ON tp.tag_id = tags.id
		WHERE tp.post_id IN (SELECT value FROM json_each(?))
	`

	type tagAssoc struct {
		PostID  int64  `db:"post_id"`
		TagName string `db:"tag_name"`
	}

	var assocs []tagAssoc
	err := s.db.SelectContext(ctx, &assocs, query, string(idsJSON))
	if err != nil {
		return err
	}

	// Group tags by post ID
	tagsByPost := make(map[int64][]string)
	for _, assoc := range assocs {
		tagsByPost[assoc.PostID] = append(tagsByPost[assoc.PostID], assoc.TagName)
	}

	// Attach tags to posts
	for i := range posts {
		if tags, ok := tagsByPost[posts[i].ID]; ok {
			posts[i].Tags = tags
		} else {
			posts[i].Tags = []string{}
		}
	}

	return nil
}

// attachParents attaches parent posts to the given posts
// It modifies the posts slice in place
func (s *PostService) attachParents(ctx context.Context, posts []models.Post) error {
	if len(posts) == 0 {
		return nil
	}

	// Collect parent IDs
	parentIDs := make([]int64, 0)
	for _, post := range posts {
		if post.ParentID.Valid {
			parentIDs = append(parentIDs, post.ParentID.Int64)
		}
	}

	if len(parentIDs) == 0 {
		return nil
	}

	// Fetch parents
	idsJSON, _ := json.Marshal(parentIDs)
	query := `
		SELECT *
		FROM posts
		WHERE id IN (SELECT value FROM json_each(?))
		AND deleted_at IS NULL
	`

	var parents []models.Post
	err := s.db.SelectContext(ctx, &parents, query, string(idsJSON))
	if err != nil {
		return err
	}

	// Create parent map
	parentMap := make(map[int64]*models.Post)
	for i := range parents {
		parents[i].Tags = []string{}
		parentMap[parents[i].ID] = &parents[i]
	}

	// Attach parents to posts
	for i := range posts {
		if posts[i].ParentID.Valid {
			if parent, ok := parentMap[posts[i].ParentID.Int64]; ok {
				posts[i].Parent = parent
			}
		}
	}

	return nil
}

// extractHashTags extracts hashtags from the post content
// It returns a map of unique hashtag names
func extractHashTags(content string) map[string]bool {
	tags := make(map[string]bool)
	matches := hashTagRegex.FindAllStringSubmatch(content, -1)
	for _, match := range matches {
		if len(match) > 1 {
			tags[match[1]] = true
		}
	}
	return tags
}
