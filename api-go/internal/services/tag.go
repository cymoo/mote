package services

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/cymoo/mote/internal/models"
	"github.com/jmoiron/sqlx"
)

var (
	ErrTagNotFound = errors.New("tag not found")
)

type TagService struct {
	db *sqlx.DB
}

func NewTagService(db *sqlx.DB) *TagService {
	return &TagService{db: db}
}

// GetCount returns the total count of tags
func (s *TagService) GetCount(ctx context.Context) (int64, error) {
	query := `SELECT COUNT(*) FROM tags`

	var count int64
	err := s.db.GetContext(ctx, &count, query)
	return count, err
}

// GetAllWithPostCount retrieves all tags with their post counts
func (s *TagService) GetAllWithPostCount(ctx context.Context) ([]models.TagWithPostCount, error) {
	query := `
		SELECT t.name, t.sticky,
			COALESCE(COUNT(DISTINCT tpa.post_id), 0) AS post_count
		FROM tags t
		LEFT JOIN tags child ON child.name = t.name OR child.name LIKE (t.name || '/%')
		LEFT JOIN tag_post_assoc tpa ON tpa.tag_id = child.id
		GROUP BY t.name, t.sticky
	`

	tags := []models.TagWithPostCount{}
	err := s.db.SelectContext(ctx, &tags, query)
	return tags, err
}

// GetAllWithUndeletedPostCount retrieves all tags with counts of non-deleted posts
// It excludes posts that have a non-null deleted_at timestamp
func (s *TagService) GetAllWithUndeletedPostCount(ctx context.Context) ([]models.TagWithPostCount, error) {
	query := `
		SELECT t.name AS name,
			   t.sticky AS sticky,
			   COALESCE(COUNT(DISTINCT p.id), 0) AS post_count
		FROM tags t
		LEFT JOIN tags child ON child.name = t.name OR child.name LIKE (t.name || '/%')
		LEFT JOIN tag_post_assoc tpa ON tpa.tag_id = child.id
		LEFT JOIN posts p ON tpa.post_id = p.id AND p.deleted_at IS NULL
		GROUP BY t.name, t.sticky
	`

	var tags []models.TagWithPostCount
	err := s.db.SelectContext(ctx, &tags, query)
	return tags, err
}

// GetPosts retrieves all posts associated with a tag (including subtags)
// For example, the tag "animal" will include posts tagged with "animal/mammal"
func (s *TagService) GetPosts(ctx context.Context, name string) ([]models.Post, error) {
	namePattern := escapeLike(name) + "/%"
	query := `
		SELECT p.*
		FROM posts p
		WHERE EXISTS (
			SELECT 1
			FROM tags t
			JOIN tag_post_assoc tp ON t.id = tp.tag_id
			WHERE tp.post_id = p.id
			AND (t.name = ? OR t.name LIKE ? ESCAPE '\')
		)
		AND p.deleted_at IS NULL
	`

	var posts []models.Post
	err := s.db.SelectContext(ctx, &posts, query, name, namePattern)
	if err != nil {
		return nil, err
	}

	return posts, nil
}

// InsertOrUpdate inserts a new tag or updates its sticky status
// If the tag already exists, its sticky status is updated
// If it does not exist, a new tag is created
func (s *TagService) InsertOrUpdate(ctx context.Context, name string, sticky bool) error {
	now := time.Now().UnixMilli()

	query := `
		INSERT INTO tags (name, sticky, created_at, updated_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(name) DO UPDATE SET
			sticky = excluded.sticky,
			updated_at = excluded.updated_at
	`

	_, err := s.db.ExecContext(ctx, query, name, sticky, now, now)
	return err
}

// DeleteAssociatedPosts soft-deletes all posts associated with a tag
// It sets the deleted_at field to the current timestamp for posts linked to the specified tag and its subtags
func (s *TagService) DeleteAssociatedPosts(ctx context.Context, name string) error {
	now := time.Now().UnixMilli()
	namePattern := escapeLike(name) + "/%"

	query := `
		UPDATE posts
		SET deleted_at = ?
		WHERE id IN (
			SELECT post_id
			FROM tag_post_assoc
			WHERE tag_id IN (
				SELECT id
				FROM tags
				WHERE name = ? OR name LIKE ? ESCAPE '\'
			)
		)
	`

	_, err := s.db.ExecContext(ctx, query, now, name, namePattern)
	return err
}

// RenameOrMerge renames a tag or merges it with an existing tag
// NewName cannot be a subtag of oldName, for example, renaming "animal" to "animal/mammal" is invalid
// If newName already exists, posts from oldName will be merged into newName, and oldName will be deleted
// If newName does not exist, oldName will be renamed to newName
// All subtags of oldName will be processed similarly
// For example, renaming "animal" to "creature" will also rename "animal/mammal" to "creature/mammal"
// If "creature/mammal" already exists, "animal/mammal" will be merged into it
// If "creature/mammal" does not exist, "animal/mammal" will be renamed to "creature/mammal"
// The operation is atomic; if any part fails, no changes are made
func (s *TagService) RenameOrMerge(ctx context.Context, oldName, newName string) error {
	if oldName == newName {
		return nil
	}

	// Check for invalid hierarchy
	// It should be impossible to hit this case via the API, but we check anyway
	if strings.HasPrefix(newName, oldName+"/") {
		panic(fmt.Sprintf("cannot move %q to a subtag of itself %q", oldName, newName))
	}

	namePattern := escapeLike(oldName) + "/%"

	// Get all source-side affected tags and the direct merge target.
	query := `
		SELECT * FROM tags
		WHERE name = ? OR name = ? OR name LIKE ? ESCAPE '\'
	`

	var affectedTags []models.Tag
	err := s.db.SelectContext(ctx, &affectedTags, query, oldName, newName, namePattern)
	if err != nil {
		return err
	}

	// Check if there is anything to rename. Parents can be virtual in the
	// sidebar tree when only descendants exist, so descendants are valid sources.
	var sourceExists, hasDescendants bool
	for i := range affectedTags {
		switch {
		case affectedTags[i].Name == oldName:
			sourceExists = true
		case strings.HasPrefix(affectedTags[i].Name, oldName+"/"):
			hasDescendants = true
		}
	}
	if !sourceExists && !hasDescendants {
		return ErrTagNotFound
	}

	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Find source and target tags
	var sourceTag *models.Tag
	var targetTag *models.Tag
	descendants := make([]*models.Tag, 0)

	for i := range affectedTags {
		tag := &affectedTags[i]
		switch tag.Name {
		case oldName:
			sourceTag = tag
		case newName:
			targetTag = tag
		default:
			descendants = append(descendants, tag)
		}
	}

	// Sort descendants by depth (deepest first)
	sort.Slice(descendants, func(i, j int) bool {
		return strings.Count(descendants[i].Name, "/") > strings.Count(descendants[j].Name, "/")
	})

	// Process descendants
	for _, descendant := range descendants {
		newDescendantName := replacePrefix(descendant.Name, oldName, newName)
		targetDescendant, err := s.findByName(ctx, tx, newDescendantName)
		if err != nil {
			return err
		}

		if targetDescendant != nil {
			// Target exists - merge
			if err := s.merge(ctx, tx, descendant, targetDescendant); err != nil {
				return err
			}
		} else {
			// Target doesn't exist - rename
			if err := s.rename(ctx, tx, descendant, newDescendantName); err != nil {
				return err
			}
		}
	}

	if sourceTag != nil {
		// Process source tag
		if targetTag != nil {
			if err := s.merge(ctx, tx, sourceTag, targetTag); err != nil {
				return err
			}
		} else {
			if err := s.rename(ctx, tx, sourceTag, newName); err != nil {
				return err
			}
		}
	} else if targetTag == nil {
		if _, err := s.create(ctx, tx, newName); err != nil {
			return err
		}
	}

	return tx.Commit()
}

// findOrCreate finds a tag by name or creates it if it doesn't exist
func (s *TagService) findOrCreate(ctx context.Context, tx *sqlx.Tx, name string) (*models.Tag, error) {
	tag, err := s.findByName(ctx, tx, name)
	if err != nil {
		return nil, err
	}
	if tag != nil {
		return tag, nil
	}

	return s.create(ctx, tx, name)
}

// Helper functions

// findByName finds a tag by its name
func (s *TagService) findByName(ctx context.Context, tx *sqlx.Tx, name string) (*models.Tag, error) {
	query := `SELECT * FROM tags WHERE name = ?`

	var tag models.Tag
	err := tx.GetContext(ctx, &tag, query, name)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	return &tag, nil
}

// create creates a new tag with the given name, returning the created tag
func (s *TagService) create(ctx context.Context, tx *sqlx.Tx, name string) (*models.Tag, error) {
	now := time.Now().UnixMilli()

	query := `
		INSERT INTO tags (name, sticky, created_at, updated_at)
		VALUES (?, false, ?, ?)
		RETURNING id
	`

	var id int64
	err := tx.QueryRowContext(ctx, query, name, now, now).Scan(&id)
	if err != nil {
		return nil, err
	}

	return &models.Tag{
		ID:        id,
		Name:      name,
		Sticky:    false,
		CreatedAt: now,
		UpdatedAt: now,
	}, nil
}

// rename renames a tag to a new name
// It also updates post contents to reflect the new tag name, including subtags
func (s *TagService) rename(ctx context.Context, tx *sqlx.Tx, tag *models.Tag, newName string) error {
	now := time.Now().UnixMilli()

	// Update tag name
	query := `UPDATE tags SET name = ?, updated_at = ? WHERE id = ?`
	_, err := tx.ExecContext(ctx, query, newName, now, tag.ID)
	if err != nil {
		return err
	}

	// Update post content
	sourcePattern := fmt.Sprintf(">#%s<", tag.Name)
	targetPattern := fmt.Sprintf(">#%s<", newName)

	updateQuery := `
		UPDATE posts
		SET content = REPLACE(content, ?, ?)
		WHERE id IN (
			SELECT post_id
			FROM tag_post_assoc
			WHERE tag_id = ?
		)
	`

	_, err = tx.ExecContext(ctx, updateQuery, sourcePattern, targetPattern, tag.ID)
	return err
}

// merge merges a source tag into a target tag
// It updates post contents to replace source tag with target tag
// It also updates tag associations and deletes the source tag
func (s *TagService) merge(ctx context.Context, tx *sqlx.Tx, sourceTag, targetTag *models.Tag) error {
	// Update post content
	sourcePattern := fmt.Sprintf(">#%s<", sourceTag.Name)
	targetPattern := fmt.Sprintf(">#%s<", targetTag.Name)

	updateQuery := `
		UPDATE posts
		SET content = REPLACE(content, ?, ?)
		WHERE id IN (
			SELECT post_id
			FROM tag_post_assoc
			WHERE tag_id = ?
		)
	`

	_, err := tx.ExecContext(ctx, updateQuery, sourcePattern, targetPattern, sourceTag.ID)
	if err != nil {
		return err
	}

	// Insert new tag associations (ignore if they already exist)
	insertQuery := `
		INSERT OR IGNORE INTO tag_post_assoc (post_id, tag_id)
		SELECT post_id, ? as tag_id
		FROM tag_post_assoc
		WHERE tag_id = ?
	`

	_, err = tx.ExecContext(ctx, insertQuery, targetTag.ID, sourceTag.ID)
	if err != nil {
		return err
	}

	// Delete old tag associations
	deleteQuery := `DELETE FROM tag_post_assoc WHERE tag_id = ?`
	_, err = tx.ExecContext(ctx, deleteQuery, sourceTag.ID)
	if err != nil {
		return err
	}

	// Delete the source tag itself
	deleteTagQuery := `DELETE FROM tags WHERE id = ?`
	_, err = tx.ExecContext(ctx, deleteTagQuery, sourceTag.ID)
	return err
}

// replacePrefix replaces the prefix of a string
func replacePrefix(s, oldPrefix, newPrefix string) string {
	if !strings.HasPrefix(s, oldPrefix) {
		return s
	}
	return newPrefix + s[len(oldPrefix):]
}

// escapeLike escapes special characters in LIKE patterns
func escapeLike(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `%`, `\%`)
	s = strings.ReplaceAll(s, `_`, `\_`)
	return s
}
