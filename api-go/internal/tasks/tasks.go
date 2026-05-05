package tasks

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/cymoo/mita"
	"github.com/cymoo/mote/pkg/fulltext"
	"github.com/jmoiron/sqlx"
)

// PurgeOldPosts deletes posts that were marked as deleted more than 30 days ago
func PurgeOldPosts(ctx context.Context) error {
	db := ctx.Value(mita.CtxtKey("db")).(*sqlx.DB)

	thirtyDaysAgo := time.Now().UTC().AddDate(0, 0, -30).UnixMilli()

	result, err := db.Exec("DELETE FROM posts WHERE deleted_at < $1", thirtyDaysAgo)
	if err != nil {
		return fmt.Errorf("error deleting old posts: %w", err)
	}

	rowsAffected, _ := result.RowsAffected()
	if rowsAffected > 0 {
		log.Printf("[Daily] successfully deleted %d posts", rowsAffected)
	}
	return nil
}

// RebuildFullTextIndex rebuilds the full-text search index for all documents
func RebuildFullTextIndex(ctx context.Context) error {
	// Get FullTextSearch and DB from context
	fts := ctx.Value(mita.CtxtKey("fts")).(*fulltext.FullTextSearch)
	db := ctx.Value(mita.CtxtKey("db")).(*sqlx.DB)

	type Post struct {
		ID      int64  `db:"id"`
		Content string `db:"content"`
	}

	// Clear existing indexes
	if err := fts.ClearIndex(ctx); err != nil {
		return fmt.Errorf("error clearing full-text indexes: %w", err)
	}

	var results []Post

	// Fetch all posts from the database
	err := db.SelectContext(ctx, &results, "SELECT id, content FROM posts")
	if err != nil {
		return fmt.Errorf("error fetching posts for full-text indexing: %w", err)
	}

	// Re-index each post
	for _, post := range results {
		id := post.ID
		content := post.Content

		if err := fts.Index(ctx, id, content); err != nil {
			log.Printf("error indexing document ID %d: %v", id, err)
		}
	}

	log.Printf("successfully rebuilt full-text index for %d documents", len(results))

	return nil
}
