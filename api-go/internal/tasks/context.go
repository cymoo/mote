package tasks

import (
	"context"
	"fmt"

	"github.com/cymoo/mita"
	"github.com/cymoo/mote/pkg/fulltext"
	"github.com/jmoiron/sqlx"
)

const (
	ContextDB         = "db"
	ContextFTS        = "fts"
	ContextUploadPath = "upload_path"
)

func dbFromContext(ctx context.Context) (*sqlx.DB, error) {
	db, ok := mita.ContextValue(ctx, ContextDB).(*sqlx.DB)
	if !ok || db == nil {
		return nil, fmt.Errorf("task context missing %q database", ContextDB)
	}
	return db, nil
}

func ftsFromContext(ctx context.Context) (*fulltext.FullTextSearch, error) {
	fts, ok := mita.ContextValue(ctx, ContextFTS).(*fulltext.FullTextSearch)
	if !ok || fts == nil {
		return nil, fmt.Errorf("task context missing %q full-text search", ContextFTS)
	}
	return fts, nil
}

func uploadPathFromContext(ctx context.Context) (string, error) {
	uploadPath, ok := mita.ContextValue(ctx, ContextUploadPath).(string)
	if !ok || uploadPath == "" {
		return "", fmt.Errorf("task context missing %q upload path", ContextUploadPath)
	}
	return uploadPath, nil
}
