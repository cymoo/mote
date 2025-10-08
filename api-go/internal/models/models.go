package models

import (
	"database/sql"
	"encoding/json"
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

// Post represents a post entity
type Post struct {
	ID            int64      `json:"id" db:"id"`
	Content       string     `json:"content" db:"content"`
	Files         string     `json:"files,omitempty" db:"files"`
	Color         NullString `json:"color,omitempty" db:"color"`
	Shared        bool       `json:"shared" db:"shared"`
	DeletedAt     NullInt64  `json:"deleted_at,omitempty" db:"deleted_at"`
	CreatedAt     int64      `json:"created_at" db:"created_at"`
	UpdatedAt     int64      `json:"updated_at" db:"updated_at"`
	ParentID      NullInt64  `json:"-" db:"parent_id"`
	ChildrenCount int64      `json:"children_count" db:"children_count"`

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

// CreatePostRequest represents the request to create a post
type CreatePostRequest struct {
	Content  string     `json:"content"`
	Files    []FileInfo `json:"files,omitempty"`
	Color    *string    `json:"color,omitempty"`
	Shared   *bool      `json:"shared,omitempty"`
	ParentID *int64     `json:"parent_id,omitempty"`
}

// UpdatePostRequest represents the request to update a post
type UpdatePostRequest struct {
	ID       int64       `json:"id"`
	Content  *string     `json:"content,omitempty"`
	Shared   *bool       `json:"shared,omitempty"`
	Files    *[]FileInfo `json:"files,omitempty"`
	Color    *string     `json:"color,omitempty"`
	ParentID *int64      `json:"parent_id,omitempty"`
}

// PostFilterOptions represents filtering options for posts
type PostFilterOptions struct {
	Cursor    *int64  `json:"cursor,omitempty"`
	Deleted   bool    `json:"deleted"`
	ParentID  *int64  `json:"parent_id,omitempty"`
	Color     *string `json:"color,omitempty"`
	Tag       *string `json:"tag,omitempty"`
	Shared    *bool   `json:"shared,omitempty"`
	HasFiles  *bool   `json:"has_files,omitempty"`
	OrderBy   string  `json:"order_by"`
	Ascending bool    `json:"ascending"`
	StartDate *int64  `json:"start_date,omitempty"`
	EndDate   *int64  `json:"end_date,omitempty"`
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

// CreateResponse represents the response after creating a post
type CreateResponse struct {
	ID        int64 `json:"id"`
	CreatedAt int64 `json:"created_at"`
	UpdatedAt int64 `json:"updated_at"`
}

// Id represents a simple ID query string parameter
type Id struct {
	Id int64 `json:"id" schema:"id"`
}

// Name represents a simple Name query string parameter
type Name struct {
	Name string `json:"name" schema:"name"`
}

type DateRange struct {
	StartDate string `json:"start_date" schema:"start_date"`
	EndDate   string `json:"end_date" schema:"end_date"`
	Offset    int    `json:"offset" schema:"offset"` // in minutes
}
