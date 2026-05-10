package services

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/cymoo/mote/internal/models"
	"github.com/jmoiron/sqlx"
	_ "modernc.org/sqlite"
)

func setupTestDB(t *testing.T) *sqlx.DB {
	// Use shared cache mode to allow multiple connections to the same in-memory database
	db, err := sqlx.Open("sqlite", "file::memory:?cache=shared")
	if err != nil {
		t.Fatalf("failed to open database: %v", err)
	}

	// Set connection pool to 1 for in-memory database to ensure consistency
	db.SetMaxOpenConns(1)

	schema := `
	CREATE TABLE IF NOT EXISTS posts (
		id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
		content TEXT NOT NULL,
		files TEXT,
		color TEXT,
		shared Boolean NOT NULL DEFAULT FALSE,
		deleted_at BIGINT,
		created_at BIGINT NOT NULL,
		updated_at BIGINT NOT NULL,
		parent_id INTEGER,
		children_count INTEGER NOT NULL DEFAULT 0,
		FOREIGN KEY (parent_id) REFERENCES posts (id) ON DELETE SET NULL
	);

	CREATE TABLE IF NOT EXISTS tags (
		id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
		name TEXT NOT NULL UNIQUE,
		sticky BOOLEAN NOT NULL DEFAULT FALSE,
		created_at BIGINT NOT NULL,
		updated_at BIGINT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS tag_post_assoc (
		tag_id INTEGER NOT NULL,
		post_id INTEGER NOT NULL,
		FOREIGN KEY (tag_id) REFERENCES tags (id) ON DELETE CASCADE,
		FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE CASCADE,
		UNIQUE (tag_id, post_id)
	);
	`

	if _, err := db.Exec(schema); err != nil {
		t.Fatalf("failed to create schema: %v", err)
	}

	return db
}

func createTestPost(t *testing.T, db *sqlx.DB, content string, deletedAt *int64) int64 {
	now := time.Now().UnixMilli()
	query := `INSERT INTO posts (content, shared, created_at, updated_at, deleted_at)
	          VALUES (?, false, ?, ?, ?) RETURNING id`

	var id int64
	err := db.QueryRow(query, content, now, now, deletedAt).Scan(&id)
	if err != nil {
		t.Fatalf("failed to create post: %v", err)
	}
	return id
}

func createTestTag(t *testing.T, db *sqlx.DB, name string, sticky bool) int64 {
	now := time.Now().UnixMilli()
	query := `INSERT INTO tags (name, sticky, created_at, updated_at)
	          VALUES (?, ?, ?, ?) RETURNING id`

	var id int64
	err := db.QueryRow(query, name, sticky, now, now).Scan(&id)
	if err != nil {
		t.Fatalf("failed to create tag: %v", err)
	}
	return id
}

func associateTagPost(t *testing.T, db *sqlx.DB, tagID, postID int64) {
	query := `INSERT INTO tag_post_assoc (tag_id, post_id) VALUES (?, ?)`
	if _, err := db.Exec(query, tagID, postID); err != nil {
		t.Fatalf("failed to associate tag and post: %v", err)
	}
}

func TestGetCount(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	service := NewTagService(db)
	ctx := context.Background()

	// Initially no tags
	count, err := service.GetCount(ctx)
	if err != nil {
		t.Fatalf("GetCount failed: %v", err)
	}
	if count != 0 {
		t.Errorf("expected count 0, got %d", count)
	}

	// Create some tags
	createTestTag(t, db, "golang", false)
	createTestTag(t, db, "python", false)
	createTestTag(t, db, "javascript", true)

	count, err = service.GetCount(ctx)
	if err != nil {
		t.Fatalf("GetCount failed: %v", err)
	}
	if count != 3 {
		t.Errorf("expected count 3, got %d", count)
	}
}

func TestGetAllWithPostCount(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	service := NewTagService(db)
	ctx := context.Background()

	// Create tags
	tag1ID := createTestTag(t, db, "tech", false)
	tag2ID := createTestTag(t, db, "tech/golang", false)
	tag3ID := createTestTag(t, db, "tech/python", true)
	createTestTag(t, db, "cooking", false)

	// Create posts
	post1ID := createTestPost(t, db, "Post about >#tech<", nil)
	post2ID := createTestPost(t, db, "Post about >#tech/golang<", nil)
	post3ID := createTestPost(t, db, "Post about >#tech/python<", nil)
	post4ID := createTestPost(t, db, "Post about >#tech/golang<", nil)

	// Associate tags with posts
	associateTagPost(t, db, tag1ID, post1ID)
	associateTagPost(t, db, tag2ID, post2ID)
	associateTagPost(t, db, tag2ID, post4ID)
	associateTagPost(t, db, tag3ID, post3ID)

	// Get all tags with post count
	tags, err := service.GetAllWithPostCount(ctx)
	if err != nil {
		t.Fatalf("GetAllWithPostCount failed: %v", err)
	}

	if len(tags) != 4 {
		t.Errorf("expected 4 tags, got %d", len(tags))
	}

	// Check post counts
	tagMap := make(map[string]int64)
	for _, tag := range tags {
		tagMap[tag.Name] = tag.PostCount
	}

	if tagMap["tech"] != 4 { // includes subtags
		t.Errorf("expected tech to have 4 posts, got %d", tagMap["tech"])
	}
	if tagMap["tech/golang"] != 2 {
		t.Errorf("expected tech/golang to have 2 posts, got %d", tagMap["tech/golang"])
	}
	if tagMap["tech/python"] != 1 {
		t.Errorf("expected tech/python to have 1 post, got %d", tagMap["tech/python"])
	}
	if tagMap["cooking"] != 0 {
		t.Errorf("expected cooking to have 0 posts, got %d", tagMap["cooking"])
	}
}

func TestGetAllWithUndeletedPostCount(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	service := NewTagService(db)
	ctx := context.Background()

	// Create tags
	tagID := createTestTag(t, db, "tech", false)

	// Create posts (one deleted)
	now := time.Now().UnixMilli()
	post1ID := createTestPost(t, db, "Active post", nil)
	post2ID := createTestPost(t, db, "Deleted post", &now)

	// Associate tags with posts
	associateTagPost(t, db, tagID, post1ID)
	associateTagPost(t, db, tagID, post2ID)

	// Get tags with undeleted post count
	tags, err := service.GetAllWithUndeletedPostCount(ctx)
	if err != nil {
		t.Fatalf("GetAllWithUndeletedPostCount failed: %v", err)
	}

	if len(tags) != 1 {
		t.Fatalf("expected 1 tag, got %d", len(tags))
	}

	if tags[0].PostCount != 1 {
		t.Errorf("expected post count 1, got %d", tags[0].PostCount)
	}
}

func TestGetPosts(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	service := NewTagService(db)
	ctx := context.Background()

	// Create tags
	tag1ID := createTestTag(t, db, "tech", false)
	tag2ID := createTestTag(t, db, "tech/golang", false)

	// Create posts
	post1ID := createTestPost(t, db, "Post 1", nil)
	post2ID := createTestPost(t, db, "Post 2", nil)
	post3ID := createTestPost(t, db, "Post 3", nil)
	now := time.Now().UnixMilli()
	post4ID := createTestPost(t, db, "Deleted post", &now)

	// Associate tags with posts
	associateTagPost(t, db, tag1ID, post1ID)
	associateTagPost(t, db, tag2ID, post2ID)
	associateTagPost(t, db, tag2ID, post3ID)
	associateTagPost(t, db, tag1ID, post4ID) // deleted post

	// Get posts for "tech" (should include subtags)
	posts, err := service.GetPosts(ctx, "tech")
	if err != nil {
		t.Fatalf("GetPosts failed: %v", err)
	}

	if len(posts) != 3 { // excludes deleted post
		t.Errorf("expected 3 posts, got %d", len(posts))
	}

	// Get posts for "tech/golang"
	posts, err = service.GetPosts(ctx, "tech/golang")
	if err != nil {
		t.Fatalf("GetPosts failed: %v", err)
	}

	if len(posts) != 2 {
		t.Errorf("expected 2 posts, got %d", len(posts))
	}
}

func TestGetPostsWithSpecialCharacters(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	service := NewTagService(db)
	ctx := context.Background()

	// Create tag with special characters
	tagID := createTestTag(t, db, "c%", false)
	postID := createTestPost(t, db, "Post 1", nil)
	associateTagPost(t, db, tagID, postID)

	// Should not match tags that don't actually match the pattern
	otherTagID := createTestTag(t, db, "cpp", false)
	otherPostID := createTestPost(t, db, "Post 2", nil)
	associateTagPost(t, db, otherTagID, otherPostID)

	posts, err := service.GetPosts(ctx, "c%")
	if err != nil {
		t.Fatalf("GetPosts failed: %v", err)
	}

	if len(posts) != 1 {
		t.Errorf("expected 1 post, got %d", len(posts))
	}
}

func TestInsertOrUpdate(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	service := NewTagService(db)
	ctx := context.Background()

	// Insert new tag
	err := service.InsertOrUpdate(ctx, "golang", false)
	if err != nil {
		t.Fatalf("InsertOrUpdate failed: %v", err)
	}

	// Verify tag was created
	var tag models.Tag
	err = db.Get(&tag, "SELECT * FROM tags WHERE name = ?", "golang")
	if err != nil {
		t.Fatalf("failed to get tag: %v", err)
	}

	if tag.Sticky {
		t.Error("expected sticky to be false")
	}

	// Update existing tag
	err = service.InsertOrUpdate(ctx, "golang", true)
	if err != nil {
		t.Fatalf("InsertOrUpdate failed: %v", err)
	}

	// Verify tag was updated
	err = db.Get(&tag, "SELECT * FROM tags WHERE name = ?", "golang")
	if err != nil {
		t.Fatalf("failed to get tag: %v", err)
	}

	if !tag.Sticky {
		t.Error("expected sticky to be true")
	}
}

func TestDeleteAssociatedPosts(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	service := NewTagService(db)
	ctx := context.Background()

	// Create tags
	tag1ID := createTestTag(t, db, "tech", false)
	tag2ID := createTestTag(t, db, "tech/golang", false)
	tag3ID := createTestTag(t, db, "cooking", false)

	// Create posts
	post1ID := createTestPost(t, db, "Post 1", nil)
	post2ID := createTestPost(t, db, "Post 2", nil)
	post3ID := createTestPost(t, db, "Post 3", nil)

	// Associate tags with posts
	associateTagPost(t, db, tag1ID, post1ID)
	associateTagPost(t, db, tag2ID, post2ID)
	associateTagPost(t, db, tag3ID, post3ID)

	// Delete posts associated with "tech" (includes subtags)
	err := service.DeleteAssociatedPosts(ctx, "tech")
	if err != nil {
		t.Fatalf("DeleteAssociatedPosts failed: %v", err)
	}

	// Verify deletions
	var post models.Post

	err = db.Get(&post, "SELECT * FROM posts WHERE id = ?", post1ID)
	if err != nil {
		t.Fatalf("failed to get post: %v", err)
	}
	if !post.DeletedAt.Valid {
		t.Error("post 1 should be deleted")
	}

	err = db.Get(&post, "SELECT * FROM posts WHERE id = ?", post2ID)
	if err != nil {
		t.Fatalf("failed to get post: %v", err)
	}
	if !post.DeletedAt.Valid {
		t.Error("post 2 should be deleted")
	}

	err = db.Get(&post, "SELECT * FROM posts WHERE id = ?", post3ID)
	if err != nil {
		t.Fatalf("failed to get post: %v", err)
	}
	if post.DeletedAt.Valid {
		t.Error("post 3 should not be deleted")
	}
}

func TestRenameOrMerge_SimpleRename(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	service := NewTagService(db)
	ctx := context.Background()

	// Create tag
	tagID := createTestTag(t, db, "golang", false)
	postID := createTestPost(t, db, "Post about >#golang<", nil)
	associateTagPost(t, db, tagID, postID)

	// Rename tag
	err := service.RenameOrMerge(ctx, "golang", "go")
	if err != nil {
		t.Fatalf("RenameOrMerge failed: %v", err)
	}

	// Verify tag was renamed
	var tag models.Tag
	err = db.Get(&tag, "SELECT * FROM tags WHERE name = ?", "go")
	if err != nil {
		t.Fatalf("failed to get renamed tag: %v", err)
	}

	// Verify old tag doesn't exist
	err = db.Get(&tag, "SELECT * FROM tags WHERE name = ?", "golang")
	if err != sql.ErrNoRows {
		t.Error("old tag should not exist")
	}

	// Verify post content was updated
	var post models.Post
	err = db.Get(&post, "SELECT * FROM posts WHERE id = ?", postID)
	if err != nil {
		t.Fatalf("failed to get post: %v", err)
	}
	if post.Content != "Post about >#go<" {
		t.Errorf("expected post content to be updated, got: %s", post.Content)
	}
}

func TestRenameOrMerge_Merge(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	service := NewTagService(db)
	ctx := context.Background()

	// Create tags
	tag1ID := createTestTag(t, db, "golang", false)
	tag2ID := createTestTag(t, db, "go", true)

	// Create posts
	post1ID := createTestPost(t, db, "Post about >#golang<", nil)
	post2ID := createTestPost(t, db, "Post about >#go<", nil)
	associateTagPost(t, db, tag1ID, post1ID)
	associateTagPost(t, db, tag2ID, post2ID)

	// Merge golang into go
	err := service.RenameOrMerge(ctx, "golang", "go")
	if err != nil {
		t.Fatalf("RenameOrMerge failed: %v", err)
	}

	// Verify golang tag was deleted
	var tag models.Tag
	err = db.Get(&tag, "SELECT * FROM tags WHERE name = ?", "golang")
	if err != sql.ErrNoRows {
		t.Error("golang tag should be deleted after merge")
	}

	// Verify go tag still exists
	err = db.Get(&tag, "SELECT * FROM tags WHERE name = ?", "go")
	if err != nil {
		t.Fatalf("go tag should still exist: %v", err)
	}

	// Verify both posts are now associated with go tag
	var count int
	err = db.Get(&count, "SELECT COUNT(*) FROM tag_post_assoc WHERE tag_id = ?", tag2ID)
	if err != nil {
		t.Fatalf("failed to count associations: %v", err)
	}
	if count != 2 {
		t.Errorf("expected 2 associations with go tag, got %d", count)
	}

	// Verify post content was updated
	var post models.Post
	err = db.Get(&post, "SELECT * FROM posts WHERE id = ?", post1ID)
	if err != nil {
		t.Fatalf("failed to get post: %v", err)
	}
	if post.Content != "Post about >#go<" {
		t.Errorf("expected post content to be updated, got: %s", post.Content)
	}
}

func TestRenameOrMerge_WithSubtags(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	service := NewTagService(db)
	ctx := context.Background()

	// Create tags with hierarchy
	createTestTag(t, db, "tech", false)
	createTestTag(t, db, "tech/golang", false)
	createTestTag(t, db, "tech/golang/web", false)

	// Rename tech to technology
	err := service.RenameOrMerge(ctx, "tech", "technology")
	if err != nil {
		t.Fatalf("RenameOrMerge failed: %v", err)
	}

	// Verify all tags were renamed
	var tags []models.Tag
	err = db.Select(&tags, "SELECT * FROM tags ORDER BY name")
	if err != nil {
		t.Fatalf("failed to get tags: %v", err)
	}

	expectedNames := []string{"technology", "technology/golang", "technology/golang/web"}
	if len(tags) != len(expectedNames) {
		t.Fatalf("expected %d tags, got %d", len(expectedNames), len(tags))
	}

	for i, tag := range tags {
		if tag.Name != expectedNames[i] {
			t.Errorf("expected tag name %s, got %s", expectedNames[i], tag.Name)
		}
	}
}

func TestRenameOrMerge_MergeWithSubtags(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	service := NewTagService(db)
	ctx := context.Background()

	// Create source hierarchy
	tag1ID := createTestTag(t, db, "tech", false)
	tag2ID := createTestTag(t, db, "tech/golang", false)

	// Create target hierarchy
	tag3ID := createTestTag(t, db, "technology", true)
	tag4ID := createTestTag(t, db, "technology/golang", false)

	// Create posts
	post1ID := createTestPost(t, db, "Post 1", nil)
	post2ID := createTestPost(t, db, "Post 2", nil)
	post3ID := createTestPost(t, db, "Post 3", nil)
	post4ID := createTestPost(t, db, "Post 4", nil)

	associateTagPost(t, db, tag1ID, post1ID)
	associateTagPost(t, db, tag2ID, post2ID)
	associateTagPost(t, db, tag3ID, post3ID)
	associateTagPost(t, db, tag4ID, post4ID)

	// Merge tech into technology
	err := service.RenameOrMerge(ctx, "tech", "technology")
	if err != nil {
		t.Fatalf("RenameOrMerge failed: %v", err)
	}

	// Verify source tags were deleted
	var count int
	err = db.Get(&count, "SELECT COUNT(*) FROM tags WHERE name = 'tech' OR name LIKE 'tech/%'")
	if err != nil {
		t.Fatalf("failed to count tags: %v", err)
	}
	if count != 0 {
		t.Errorf("expected 0 tech tags remaining, got %d", count)
	}

	// Verify only target tags remain
	err = db.Get(&count, "SELECT COUNT(*) FROM tags WHERE name = 'technology' OR name LIKE 'technology/%'")
	if err != nil {
		t.Fatalf("failed to count tags: %v", err)
	}
	if count != 2 {
		t.Errorf("expected 2 technology tags, got %d", count)
	}

	// Verify all posts are associated with target tags
	err = db.Get(&count, "SELECT COUNT(*) FROM tag_post_assoc WHERE tag_id = ?", tag3ID)
	if err != nil {
		t.Fatalf("failed to count associations: %v", err)
	}
	if count != 2 {
		t.Errorf("expected 2 posts associated with technology, got %d", count)
	}

	err = db.Get(&count, "SELECT COUNT(*) FROM tag_post_assoc WHERE tag_id = ?", tag4ID)
	if err != nil {
		t.Fatalf("failed to count associations: %v", err)
	}
	if count != 2 {
		t.Errorf("expected 2 posts associated with technology/golang, got %d", count)
	}
}

func TestRenameOrMerge_VirtualParentWithSubtags(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	service := NewTagService(db)
	ctx := context.Background()

	sourceChildID := createTestTag(t, db, "foo1/bar", false)
	targetID := createTestTag(t, db, "foo", false)
	post1ID := createTestPost(t, db, "Post about >#foo1/bar<", nil)
	post2ID := createTestPost(t, db, "Post about >#foo<", nil)
	associateTagPost(t, db, sourceChildID, post1ID)
	associateTagPost(t, db, targetID, post2ID)

	err := service.RenameOrMerge(ctx, "foo1", "foo")
	if err != nil {
		t.Fatalf("RenameOrMerge failed: %v", err)
	}

	var tags []models.Tag
	err = db.Select(&tags, "SELECT * FROM tags ORDER BY name")
	if err != nil {
		t.Fatalf("failed to get tags: %v", err)
	}

	expectedNames := []string{"foo", "foo/bar"}
	if len(tags) != len(expectedNames) {
		t.Fatalf("expected %d tags, got %d", len(expectedNames), len(tags))
	}

	for i, tag := range tags {
		if tag.Name != expectedNames[i] {
			t.Errorf("expected tag name %s, got %s", expectedNames[i], tag.Name)
		}
	}

	var post models.Post
	err = db.Get(&post, "SELECT * FROM posts WHERE id = ?", post1ID)
	if err != nil {
		t.Fatalf("failed to get post: %v", err)
	}
	if post.Content != "Post about >#foo/bar<" {
		t.Errorf("expected post content to be updated, got: %s", post.Content)
	}
}

func TestRenameOrMerge_VirtualParentCreatesTargetParent(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	service := NewTagService(db)
	ctx := context.Background()

	sourceChildID := createTestTag(t, db, "foo1/bar", false)
	postID := createTestPost(t, db, "Post about >#foo1/bar<", nil)
	associateTagPost(t, db, sourceChildID, postID)

	err := service.RenameOrMerge(ctx, "foo1", "foo")
	if err != nil {
		t.Fatalf("RenameOrMerge failed: %v", err)
	}

	var tags []models.Tag
	err = db.Select(&tags, "SELECT * FROM tags ORDER BY name")
	if err != nil {
		t.Fatalf("failed to get tags: %v", err)
	}

	expectedNames := []string{"foo", "foo/bar"}
	if len(tags) != len(expectedNames) {
		t.Fatalf("expected %d tags, got %d", len(expectedNames), len(tags))
	}

	for i, tag := range tags {
		if tag.Name != expectedNames[i] {
			t.Errorf("expected tag name %s, got %s", expectedNames[i], tag.Name)
		}
	}
}

func TestRenameOrMerge_SameName(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	service := NewTagService(db)
	ctx := context.Background()

	createTestTag(t, db, "golang", false)

	// Rename to same name should do nothing
	err := service.RenameOrMerge(ctx, "golang", "golang")
	if err != nil {
		t.Errorf("RenameOrMerge should not fail for same name: %v", err)
	}
}

func TestRenameOrMerge_InvalidHierarchy(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	service := NewTagService(db)
	ctx := context.Background()

	createTestTag(t, db, "tech", false)

	func() {
		defer func() {
			if r := recover(); r == nil {
				t.Error("expected panic when renaming to subtag of itself")
			} else {
				t.Logf("got expected panic: %v", r)
			}
		}()

		// Try to rename to a subtag of itself
		// This should cause a panic
		service.RenameOrMerge(ctx, "tech", "tech/golang")
	}()
}

func TestRenameOrMerge_NonExistentTag(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	service := NewTagService(db)
	ctx := context.Background()

	// Try to rename non-existent tag
	err := service.RenameOrMerge(ctx, "nonexistent", "newname")
	if err != ErrTagNotFound {
		t.Errorf("expected ErrTagNotFound, got: %v", err)
	}
}

func TestReplacePrefix(t *testing.T) {
	tests := []struct {
		name      string
		s         string
		oldPrefix string
		newPrefix string
		expected  string
	}{
		{
			name:      "simple replacement",
			s:         "tech/golang",
			oldPrefix: "tech",
			newPrefix: "technology",
			expected:  "technology/golang",
		},
		{
			name:      "no match",
			s:         "cooking/recipes",
			oldPrefix: "tech",
			newPrefix: "technology",
			expected:  "cooking/recipes",
		},
		{
			name:      "exact match",
			s:         "tech",
			oldPrefix: "tech",
			newPrefix: "technology",
			expected:  "technology",
		},
		{
			name:      "nested replacement",
			s:         "tech/golang/web",
			oldPrefix: "tech",
			newPrefix: "technology",
			expected:  "technology/golang/web",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := replacePrefix(tt.s, tt.oldPrefix, tt.newPrefix)
			if result != tt.expected {
				t.Errorf("expected %s, got %s", tt.expected, result)
			}
		})
	}
}

func TestEscapeLike(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "percent sign",
			input:    "c%",
			expected: `c\%`,
		},
		{
			name:     "underscore",
			input:    "c_lang",
			expected: `c\_lang`,
		},
		{
			name:     "backslash",
			input:    `path\to\file`,
			expected: `path\\to\\file`,
		},
		{
			name:     "multiple special chars",
			input:    `test_%\`,
			expected: `test\_\%\\`,
		},
		{
			name:     "no special chars",
			input:    "golang",
			expected: "golang",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := escapeLike(tt.input)
			if result != tt.expected {
				t.Errorf("expected %s, got %s", tt.expected, result)
			}
		})
	}
}

func TestConcurrentOperations(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	service := NewTagService(db)
	ctx := context.Background()

	// Create initial tags
	createTestTag(t, db, "tag1", false)
	createTestTag(t, db, "tag2", false)

	// Test concurrent InsertOrUpdate
	done := make(chan bool)
	for i := 0; i < 5; i++ {
		go func(idx int) {
			err := service.InsertOrUpdate(ctx, "concurrent", idx%2 == 0)
			if err != nil {
				t.Errorf("concurrent InsertOrUpdate failed: %v", err)
			}
			done <- true
		}(i)
	}

	for i := 0; i < 5; i++ {
		<-done
	}

	// Verify tag exists
	var tag models.Tag
	err := db.Get(&tag, "SELECT * FROM tags WHERE name = ?", "concurrent")
	if err != nil {
		t.Fatalf("failed to get concurrent tag: %v", err)
	}
}

func TestEdgeCases(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	service := NewTagService(db)
	ctx := context.Background()

	t.Run("tag with multiple levels", func(t *testing.T) {
		createTestTag(t, db, "a/b/c/d/e", false)
		postID := createTestPost(t, db, "Test post", nil)

		var tagID int64
		err := db.Get(&tagID, "SELECT id FROM tags WHERE name = ?", "a/b/c/d/e")
		if err != nil {
			t.Fatalf("failed to get tag: %v", err)
		}

		associateTagPost(t, db, tagID, postID)

		posts, err := service.GetPosts(ctx, "a")
		if err != nil {
			t.Fatalf("GetPosts failed: %v", err)
		}

		if len(posts) != 1 {
			t.Errorf("expected 1 post for tag hierarchy, got %d", len(posts))
		}
	})

	t.Run("rename with duplicate posts", func(t *testing.T) {
		tag1ID := createTestTag(t, db, "duplicate1", false)
		tag2ID := createTestTag(t, db, "duplicate2", false)
		postID := createTestPost(t, db, "Shared post", nil)

		associateTagPost(t, db, tag1ID, postID)
		associateTagPost(t, db, tag2ID, postID)

		// Create target tag
		targetID := createTestTag(t, db, "target", false)
		associateTagPost(t, db, targetID, postID)

		// Merge should handle duplicate associations gracefully
		err := service.RenameOrMerge(ctx, "duplicate1", "target")
		if err != nil {
			t.Fatalf("RenameOrMerge with duplicate should not fail: %v", err)
		}
	})

	t.Run("delete with no associated posts", func(t *testing.T) {
		createTestTag(t, db, "empty", false)

		err := service.DeleteAssociatedPosts(ctx, "empty")
		if err != nil {
			t.Errorf("DeleteAssociatedPosts should not fail for tag with no posts: %v", err)
		}
	})
}
