package services

import (
	"context"
	"testing"

	"github.com/cymoo/mote/internal/models"
	"github.com/jmoiron/sqlx"
)

func setupPostTestDB(t *testing.T) *sqlx.DB {
	t.Helper()
	dsn := "file:" + t.Name() + "?mode=memory&cache=shared"
	db, err := sqlx.Open("sqlite", dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })

	schema := `
CREATE TABLE posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  content TEXT NOT NULL,
  files TEXT,
  color TEXT,
  shared Boolean NOT NULL DEFAULT FALSE,
  deleted_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  parent_id INTEGER,
  children_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  name TEXT NOT NULL UNIQUE,
  sticky BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE tag_post_assoc (
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  UNIQUE (tag_id, post_id)
);`
	if _, err := db.Exec(schema); err != nil {
		t.Fatalf("schema: %v", err)
	}
	return db
}

func TestPost_CreateAndFind(t *testing.T) {
	db := setupPostTestDB(t)
	svc := NewPostService(db)
	ctx := context.Background()

	res, err := svc.Create(ctx, models.CreatePostRequest{Content: "hello #world"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if res.ID == 0 {
		t.Fatal("missing id")
	}

	got, err := svc.FindByID(ctx, res.ID)
	if err != nil {
		t.Fatalf("find: %v", err)
	}
	if got.Content != "hello #world" {
		t.Fatalf("content: %q", got.Content)
	}
}

func TestPost_HashtagsAttached(t *testing.T) {
	db := setupPostTestDB(t)
	svc := NewPostService(db)
	ctx := context.Background()

	res, err := svc.Create(ctx, models.CreatePostRequest{Content: `look at <span class="hash-tag">#foo</span> and <span class="hash-tag">#bar/baz</span>`})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	// FindByIDs hydrates tags.
	posts, err := svc.FindByIDs(ctx, []int64{res.ID})
	if err != nil {
		t.Fatalf("find: %v", err)
	}
	if len(posts) != 1 {
		t.Fatalf("got %d posts", len(posts))
	}
	tags := posts[0].Tags
	want := map[string]bool{"foo": true, "bar/baz": true}
	for _, tg := range tags {
		delete(want, tg)
	}
	if len(want) != 0 {
		t.Fatalf("missing tags %v in %v", want, tags)
	}
}

func TestPost_UpdateContent(t *testing.T) {
	db := setupPostTestDB(t)
	svc := NewPostService(db)
	ctx := context.Background()

	res, err := svc.Create(ctx, models.CreatePostRequest{Content: `old <span class="hash-tag">#a</span>`})
	if err != nil {
		t.Fatal(err)
	}
	newContent := `new <span class="hash-tag">#b</span>`
	if err := svc.Update(ctx, models.UpdatePostRequest{ID: res.ID, Content: &newContent}); err != nil {
		t.Fatalf("update: %v", err)
	}
	got, _ := svc.FindByID(ctx, res.ID)
	if got.Content != newContent {
		t.Fatalf("content not updated: %q", got.Content)
	}

	posts, _ := svc.FindByIDs(ctx, []int64{res.ID})
	if len(posts[0].Tags) != 1 || posts[0].Tags[0] != "b" {
		t.Fatalf("tags not re-synced: %v", posts[0].Tags)
	}
}

func TestPost_SoftDeleteAndRestore(t *testing.T) {
	db := setupPostTestDB(t)
	svc := NewPostService(db)
	ctx := context.Background()

	res, _ := svc.Create(ctx, models.CreatePostRequest{Content: "doomed"})
	if err := svc.Delete(ctx, res.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	got, err := svc.FindByID(ctx, res.ID)
	if err != nil {
		t.Fatalf("find: %v", err)
	}
	if got != nil {
		t.Fatal("FindByID should not return soft-deleted post")
	}
	if err := svc.Restore(ctx, res.ID); err != nil {
		t.Fatalf("restore: %v", err)
	}
	got, err = svc.FindByID(ctx, res.ID)
	if err != nil || got == nil {
		t.Fatalf("FindByID after restore: %v %v", got, err)
	}
}

func TestPost_HardDelete(t *testing.T) {
	db := setupPostTestDB(t)
	svc := NewPostService(db)
	ctx := context.Background()

	res, _ := svc.Create(ctx, models.CreatePostRequest{Content: "boom"})
	if err := svc.Delete(ctx, res.ID); err != nil {
		t.Fatalf("soft delete: %v", err)
	}
	if err := svc.HardDelete(ctx, res.ID); err != nil {
		t.Fatalf("hard delete: %v", err)
	}
	var n int
	if err := db.Get(&n, "SELECT COUNT(*) FROM posts WHERE id=?", res.ID); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("hard delete did not remove row, count=%d", n)
	}
}

func TestPost_ParentChildrenCount(t *testing.T) {
	db := setupPostTestDB(t)
	svc := NewPostService(db)
	ctx := context.Background()

	parent, _ := svc.Create(ctx, models.CreatePostRequest{Content: "parent"})
	for i := 0; i < 3; i++ {
		if _, err := svc.Create(ctx, models.CreatePostRequest{Content: "child", ParentID: &parent.ID}); err != nil {
			t.Fatal(err)
		}
	}
	got, _ := svc.FindByID(ctx, parent.ID)
	if got.ChildrenCount != 3 {
		t.Fatalf("children count: %d", got.ChildrenCount)
	}

	// Deleting one child decrements.
	rows, _ := svc.Filter(ctx, models.FilterPostRequest{ParentID: &parent.ID}, 100)
	if err := svc.Delete(ctx, rows[0].ID); err != nil {
		t.Fatalf("delete child: %v", err)
	}
	got, _ = svc.FindByID(ctx, parent.ID)
	if got.ChildrenCount != 2 {
		t.Fatalf("children count after delete: %d", got.ChildrenCount)
	}
}

func TestPost_FilterByColor(t *testing.T) {
	db := setupPostTestDB(t)
	svc := NewPostService(db)
	ctx := context.Background()

	red := "red"
	blue := "blue"
	if _, err := svc.Create(ctx, models.CreatePostRequest{Content: "r1", Color: &red}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Create(ctx, models.CreatePostRequest{Content: "b1", Color: &blue}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Create(ctx, models.CreatePostRequest{Content: "r2", Color: &red}); err != nil {
		t.Fatal(err)
	}

	got, err := svc.Filter(ctx, models.FilterPostRequest{Color: &red}, 100)
	if err != nil {
		t.Fatalf("filter: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 red, got %d", len(got))
	}
	for _, p := range got {
		if !p.Color.Valid || p.Color.String != "red" {
			t.Fatalf("unexpected color: %+v", p.Color)
		}
	}
}

func TestPost_GetCount(t *testing.T) {
	db := setupPostTestDB(t)
	svc := NewPostService(db)
	ctx := context.Background()

	for i := 0; i < 5; i++ {
		if _, err := svc.Create(ctx, models.CreatePostRequest{Content: "x"}); err != nil {
			t.Fatal(err)
		}
	}
	n, err := svc.GetCount(ctx)
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 5 {
		t.Fatalf("expected 5, got %d", n)
	}

	res, _ := svc.Create(ctx, models.CreatePostRequest{Content: "extra"})
	_ = svc.Delete(ctx, res.ID)
	n, _ = svc.GetCount(ctx)
	if n != 5 {
		t.Fatalf("soft-deleted post should not be counted: %d", n)
	}
}
