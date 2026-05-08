package app

import (
	"github.com/cymoo/mita"
	"github.com/cymoo/mote/internal/tasks"
)

// setupTasks sets up the background tasks using mita.
func (app *App) setupTasks() error {
	tm := mita.New()

	tm.SetContextValue(tasks.ContextDB, app.db)
	tm.SetContextValue(tasks.ContextFTS, app.fts)
	tm.SetContextValue(tasks.ContextUploadPath, app.config.Upload.BasePath)

	if err := tm.AddTask("delete-old-posts", mita.Every().Day().At(2, 0), tasks.PurgeOldPosts); err != nil {
		return err
	}
	if err := tm.AddTask("purge-drive-uploads", mita.Every().Hour(), tasks.PurgeExpiredDriveUploads); err != nil {
		return err
	}
	if err := tm.AddTask("purge-drive-shares", mita.Every().Hour(), tasks.PurgeExpiredDriveShares); err != nil {
		return err
	}
	if err := tm.AddTask("purge-drive-trash", mita.Every().Day().At(2, 30), tasks.PurgeOldDriveTrash); err != nil {
		return err
	}
	if err := tm.AddTask("rebuild-fulltext-index", mita.Every().Day().At(2, 0).OnDay(1), tasks.RebuildFullTextIndex); err != nil {
		return err
	}

	app.tm = tm
	return nil
}
