package models

// DriveNode represents a folder or file in the drive tree.
type DriveNode struct {
	ID            int64      `json:"id" db:"id"`
	ParentID      NullInt64  `json:"parent_id" db:"parent_id"`
	Type          string     `json:"type" db:"type"`
	Name          string     `json:"name" db:"name"`
	NameLower     string     `json:"-" db:"name_lower"`
	BlobPath      NullString `json:"-" db:"blob_path"`
	Size          NullInt64  `json:"size" db:"size"`
	MimeType      NullString `json:"mime_type" db:"mime_type"`
	Ext           NullString `json:"ext" db:"ext"`
	Hash          NullString `json:"hash,omitempty" db:"hash"`
	DeletedAt     NullInt64  `json:"deleted_at,omitempty" db:"deleted_at"`
	DeleteBatchID NullString `json:"-" db:"delete_batch_id"`
	CreatedAt     int64      `json:"created_at" db:"created_at"`
	UpdatedAt     int64      `json:"updated_at" db:"updated_at"`
}

// DriveUpload represents a resumable upload session.
type DriveUpload struct {
	ID           string    `json:"id" db:"id"`
	ParentID     NullInt64 `json:"parent_id" db:"parent_id"`
	Name         string    `json:"name" db:"name"`
	Size         int64     `json:"size" db:"size"`
	ChunkSize    int64     `json:"chunk_size" db:"chunk_size"`
	TotalChunks  int       `json:"total_chunks" db:"total_chunks"`
	ReceivedMask []byte    `json:"-" db:"received_mask"`
	Status       string    `json:"status" db:"status"`
	ExpiresAt    int64     `json:"expires_at" db:"expires_at"`
	CreatedAt    int64     `json:"created_at" db:"created_at"`
	UpdatedAt    int64     `json:"updated_at" db:"updated_at"`
}

// DriveShare represents a public share link for a file.
type DriveShare struct {
	ID           int64      `json:"id" db:"id"`
	NodeID       int64      `json:"node_id" db:"node_id"`
	TokenHash    string     `json:"-" db:"token_hash"`
	TokenPrefix  string     `json:"-" db:"token_prefix"`
	PasswordHash NullString `json:"-" db:"password_hash"`
	HasPassword  bool       `json:"has_password"`
	ExpiresAt    NullInt64  `json:"expires_at" db:"expires_at"`
	CreatedAt    int64      `json:"created_at" db:"created_at"`
	URL          string     `json:"url,omitempty"`   // populated only on creation
	Token        string     `json:"token,omitempty"` // populated only on creation
}

// ----- request DTOs -----

type DriveListRequest struct {
	ParentID *int64  `schema:"parent_id"`
	OrderBy  string  `schema:"order_by"`
	Sort     string  `schema:"sort"` // "asc" | "desc"
	Query    *string `schema:"q"`
}

type DriveCreateFolderRequest struct {
	ParentID *int64 `json:"parent_id"`
	Name     string `json:"name"`
}

type DriveRenameRequest struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

type DriveMoveRequest struct {
	IDs         []int64 `json:"ids"`
	NewParentID *int64  `json:"new_parent_id"`
}

type DriveDeleteRequest struct {
	IDs []int64 `json:"ids"`
}

type DriveRestoreRequest struct {
	ID int64 `json:"id"`
}

type DrivePurgeRequest struct {
	IDs []int64 `json:"ids"`
}

type DriveUploadInitRequest struct {
	ParentID  *int64 `json:"parent_id"`
	Name      string `json:"name"`
	Size      int64  `json:"size"`
	ChunkSize int64  `json:"chunk_size"`
}

type DriveUploadInitResponse struct {
	UploadID       string `json:"upload_id"`
	TotalChunks    int    `json:"total_chunks"`
	ChunkSize      int64  `json:"chunk_size"`
	ReceivedChunks []int  `json:"received_chunks"`
}

type DriveUploadCompleteRequest struct {
	UploadID    string `json:"upload_id"`
	OnCollision string `json:"on_collision"` // "ask"|"overwrite"|"rename"|"skip"
}

type DriveShareCreateRequest struct {
	NodeID    int64   `json:"node_id"`
	Password  *string `json:"password"`
	ExpiresAt *int64  `json:"expires_at"` // epoch ms; nil/0 = never
}

type DriveShareRevokeRequest struct {
	ShareID int64 `json:"share_id"`
}

type DriveSharePasswordRequest struct {
	Password string `json:"password"`
}

// DriveBreadcrumb represents one ancestor in a folder breadcrumb.
type DriveBreadcrumb struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}
