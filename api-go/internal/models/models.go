package models

import (
	"database/sql"
	"encoding/json"
	"fmt"

	t "github.com/cymoo/mote/pkg/util/types"
)

// NullString is a custom type that serializes to null or string
type NullString struct {
	sql.NullString
}

func (ns NullString) MarshalJSON() ([]byte, error) {
	if !ns.Valid {
		return []byte("null"), nil
	}
	return json.Marshal(ns.String)
}

func (ns *NullString) UnmarshalJSON(data []byte) error {
	var s *string
	if err := json.Unmarshal(data, &s); err != nil {
		return err
	}
	if s == nil {
		ns.Valid = false
		return nil
	}
	ns.String = *s
	ns.Valid = true
	return nil
}

// NullInt64 is a custom type that serializes to null or int64
type NullInt64 struct {
	sql.NullInt64
}

func (ni NullInt64) MarshalJSON() ([]byte, error) {
	if !ni.Valid {
		return []byte("null"), nil
	}
	return json.Marshal(ni.Int64)
}

func (ni *NullInt64) UnmarshalJSON(data []byte) error {
	var i *int64
	if err := json.Unmarshal(data, &i); err != nil {
		return err
	}
	if i == nil {
		ni.Valid = false
		return nil
	}
	ni.Int64 = *i
	ni.Valid = true
	return nil
}

type NullRawMessage struct {
	json.RawMessage
	Valid bool // Valid is true if JSON is not NULL
}

// Scan implements the Scanner interface.
func (n *NullRawMessage) Scan(value interface{}) error {
	if value == nil {
		n.RawMessage = nil
		n.Valid = false
		return nil
	}
	// Assuming value is []byte or string
	switch v := value.(type) {
	case []byte:
		n.RawMessage = json.RawMessage(v)
	case string:
		n.RawMessage = json.RawMessage(v)
	default:
		return fmt.Errorf("unsupported type for NullRawMessage: %T", value)
	}
	n.Valid = true
	return nil
}

// Post represents a post entity
type Post struct {
	ID            int64          `json:"id" db:"id"`
	Content       string         `json:"content" db:"content"`
	Files         NullRawMessage `json:"files,omitempty" db:"files"`
	Color         NullString     `json:"color,omitempty" db:"color"`
	Shared        bool           `json:"shared" db:"shared"`
	DeletedAt     NullInt64      `json:"deleted_at,omitempty" db:"deleted_at"`
	CreatedAt     int64          `json:"created_at" db:"created_at"`
	UpdatedAt     int64          `json:"updated_at" db:"updated_at"`
	ParentID      NullInt64      `json:"-" db:"parent_id"`
	ChildrenCount int64          `json:"children_count" db:"children_count"`

	// Additional fields not in DB
	Parent *Post    `json:"parent,omitempty"`
	Score  *float64 `json:"score,omitempty"`
	Tags   []string `json:"tags"`
}

// FileInfo represents file metadata
type FileInfo struct {
	URL      string  `json:"url"`
	ThumbURL *string `json:"thumb_url,omitempty"`
	Size     *uint64 `json:"size,omitempty"`
	Width    *uint32 `json:"width,omitempty"`
	Height   *uint32 `json:"height,omitempty"`
}

// Tag represents a tag entity
type Tag struct {
	ID        int64  `json:"id" db:"id"`
	Name      string `json:"name" db:"name"`
	Sticky    bool   `json:"sticky" db:"sticky"`
	CreatedAt int64  `json:"created_at" db:"created_at"`
	UpdatedAt int64  `json:"updated_at" db:"updated_at"`
}

// TagWithPostCount represents a tag with its post count
type TagWithPostCount struct {
	Name      string `json:"name" db:"name"`
	Sticky    bool   `json:"sticky" db:"sticky"`
	PostCount int64  `json:"post_count" db:"post_count"`
}

// RenameTagRequest represents the request to rename or merge a tag
type RenameTagRequest struct {
	Name    string `json:"name"`
	NewName string `json:"new_name"`
}

// StickyTagRequest represents the request to set a tag's sticky status
type StickyTagRequest struct {
	Name   string `json:"name"`
	Sticky bool   `json:"sticky"`
}

// SearchRequest represents the request to search posts
type SearchRequest struct {
	Query   string `schema:"query"`
	Limit   int    `schema:"limit"`
	Partial bool   `schema:"partial"`
}

// CreatePostRequest represents the request to create a post
type CreatePostRequest struct {
	Content  string     `json:"content"`
	Files    []FileInfo `json:"files"`
	Color    *string    `json:"color"`
	Shared   *bool      `json:"shared"`
	ParentID *int64     `json:"parent_id"`
}

// UpdatePostRequest represents the request to update a post
type UpdatePostRequest struct {
	ID      int64   `json:"id"`
	Content *string `json:"content"`
	Shared  *bool   `json:"shared"`

	Files    t.Optional[[]FileInfo] `json:"files"`
	Color    t.Optional[string]     `json:"color"`
	ParentID t.Optional[int64]      `json:"parent_id"`
}

type DeletePostRequest struct {
	ID   int64 `json:"id"`
	Hard bool  `json:"hard"`
}

// FilterPostRequest represents filtering options for posts
type FilterPostRequest struct {
	Cursor    *int64  `schema:"cursor"`
	Deleted   bool    `schema:"deleted"`
	ParentID  *int64  `schema:"parent_id"`
	Color     *string `schema:"color"`
	Tag       *string `schema:"tag"`
	Shared    *bool   `schema:"shared"`
	HasFiles  *bool   `schema:"has_files"`
	Untagged  *bool   `schema:"untagged"`
	OrderBy   string  `schema:"order_by"`
	Ascending bool    `schema:"ascending"`
	StartDate *int64  `schema:"start_date"`
	EndDate   *int64  `schema:"end_date"`
}

// PostPagination represents paginated posts
type PostPagination struct {
	Posts  []Post `json:"posts"`
	Cursor int64  `json:"cursor"`
	Size   int64  `json:"size"`
}

// PostStats represents statistics about posts
type PostStats struct {
	PostCount int64 `json:"post_count"`
	TagCount  int64 `json:"tag_count"`
	DayCount  int64 `json:"day_count"`
}

type StatCount struct {
	Name  string `json:"name" db:"name"`
	Count int64  `json:"count" db:"count"`
}

type StatsSummary struct {
	TotalPosts      int64       `json:"total_posts" db:"total_posts"`
	ActiveDays      int64       `json:"active_days" db:"active_days"`
	SharedPosts     int64       `json:"shared_posts" db:"shared_posts"`
	PostsWithImages int64       `json:"posts_with_images" db:"posts_with_images"`
	UntaggedPosts   int64       `json:"untagged_posts" db:"untagged_posts"`
	FirstPostAt     NullInt64   `json:"first_post_at" db:"first_post_at"`
	LastPostAt      NullInt64   `json:"last_post_at" db:"last_post_at"`
	ColorCounts     []StatCount `json:"color_counts"`
	TopTags         []StatCount `json:"top_tags"`
}

// CreateResponse represents the response after creating a post
type CreateResponse struct {
	ID        int64 `json:"id"`
	CreatedAt int64 `json:"created_at"`
	UpdatedAt int64 `json:"updated_at"`
}

// ID represents a simple ID query string parameter
type ID struct {
	ID int64 `schema:"id"`
}

// Name represents a simple Name query string parameter
type Name struct {
	Name string `schema:"name"`
}

// DateRange represents a date range with start and end dates
type DateRange struct {
	StartDate string `schema:"start_date"`
	EndDate   string `schema:"end_date"`
	Offset    int    `schema:"offset"` // in minutes
}

// LoginRequest represents a login request with password
type LoginRequest struct {
	Password string `json:"password"`
}
