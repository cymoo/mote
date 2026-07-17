package handlers

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	m "github.com/cymoo/mint"
	"github.com/cymoo/mote/internal/config"
	e "github.com/cymoo/mote/internal/errors"
	"github.com/cymoo/mote/internal/models"
	"github.com/cymoo/mote/internal/services"
	"github.com/go-chi/chi/v5"
)

type DriveHandler struct {
	drive  *services.DriveService
	upload *services.DriveUploadService
	share  *services.DriveShareService
	cfg    *config.Config
}

func NewDriveHandler(
	drive *services.DriveService,
	upload *services.DriveUploadService,
	share *services.DriveShareService,
	cfg *config.Config,
) *DriveHandler {
	return &DriveHandler{drive: drive, upload: upload, share: share, cfg: cfg}
}

// Routes attaches all /api/drive/* endpoints.
func (h *DriveHandler) Routes(r chi.Router) {
	r.Get("/list", m.H(h.List))
	r.Get("/breadcrumbs", m.H(h.Breadcrumbs))
	r.Get("/trash", m.H(h.Trash))
	r.Get("/starred", m.H(h.Starred))
	r.Get("/usage", m.H(h.Usage))
	r.Post("/folder", m.H(h.CreateFolder))
	r.Post("/folders/ensure-path", m.H(h.EnsurePath))
	r.Post("/rename", m.H(h.Rename))
	r.Post("/move", m.H(h.Move))
	r.Post("/copy", m.H(h.Copy))
	r.Post("/star", m.H(h.Star))
	r.Post("/delete", m.H(h.Delete))
	r.Post("/restore", m.H(h.Restore))
	r.Post("/purge", m.H(h.Purge))

	r.Get("/download", h.Download)
	r.Get("/preview", h.Preview)
	r.Get("/thumb", h.Thumbnail)
	r.Get("/download-zip", h.DownloadZip)

	r.Post("/upload/init", m.H(h.UploadInit))
	r.Get("/upload/{upload_id}", m.H(h.UploadStatus))
	r.Put("/upload/chunk/{upload_id}/{idx}", h.UploadChunk)
	r.Post("/upload/complete", m.H(h.UploadComplete))
	r.Delete("/upload/{upload_id}", h.UploadCancel)

	r.Post("/share", m.H(h.CreateShare))
	r.Get("/shares", m.H(h.ListShares))
	r.Get("/shares/all", m.H(h.ListAllShares))
	r.Post("/share/revoke", m.H(h.RevokeShare))
}

// ---------- list/tree/search ----------

type listQuery struct {
	ParentID *int64  `schema:"parent_id"`
	Q        *string `schema:"q"`
	OrderBy  string  `schema:"order_by"`
	Sort     string  `schema:"sort"`
}

func (h *DriveHandler) List(ctx context.Context, q m.Query[listQuery]) ([]models.DriveNode, error) {
	out, err := h.drive.List(ctx, q.Value.ParentID, q.Value.Q, q.Value.OrderBy, q.Value.Sort)
	if err != nil {
		return nil, mapDriveErr(err)
	}
	if out == nil {
		out = []models.DriveNode{}
	}
	return out, nil
}

type idQuery struct {
	ID int64 `schema:"id"`
}

func (h *DriveHandler) Breadcrumbs(ctx context.Context, q m.Query[idQuery]) ([]models.DriveBreadcrumb, error) {
	out, err := h.drive.Breadcrumbs(ctx, q.Value.ID)
	if err != nil {
		return nil, mapDriveErr(err)
	}
	return out, nil
}

func (h *DriveHandler) Trash(ctx context.Context) ([]models.DriveNode, error) {
	out, err := h.drive.ListTrash(ctx)
	if err != nil {
		return nil, err
	}
	if out == nil {
		out = []models.DriveNode{}
	}
	return out, nil
}

func (h *DriveHandler) Starred(ctx context.Context) ([]models.DriveNode, error) {
	out, err := h.drive.ListStarred(ctx)
	if err != nil {
		return nil, err
	}
	if out == nil {
		out = []models.DriveNode{}
	}
	return out, nil
}

func (h *DriveHandler) Usage(ctx context.Context) (*models.DriveUsage, error) {
	return h.drive.Usage(ctx)
}

// ---------- mutations ----------

func (h *DriveHandler) CreateFolder(ctx context.Context, body m.JSON[models.DriveCreateFolderRequest]) (*models.DriveNode, error) {
	n, err := h.drive.CreateFolder(ctx, body.Value.ParentID, body.Value.Name)
	if err != nil {
		return nil, mapDriveErr(err)
	}
	return n, nil
}

// EnsurePath get-or-creates a nested folder chain (folder uploads use this to
// mirror client directory structure) and returns the final folder.
func (h *DriveHandler) EnsurePath(ctx context.Context, body m.JSON[models.DriveEnsurePathRequest]) (*models.DriveNode, error) {
	n, err := h.drive.EnsureFolderPath(ctx, body.Value.ParentID, body.Value.Path)
	if err != nil {
		return nil, mapDriveErr(err)
	}
	return n, nil
}

func (h *DriveHandler) Rename(ctx context.Context, body m.JSON[models.DriveRenameRequest]) (m.StatusCode, error) {
	if err := h.drive.Rename(ctx, body.Value.ID, body.Value.Name); err != nil {
		return 0, mapDriveErr(err)
	}
	return http.StatusNoContent, nil
}

func (h *DriveHandler) Move(ctx context.Context, body m.JSON[models.DriveMoveRequest]) (m.StatusCode, error) {
	if err := h.drive.Move(ctx, body.Value.IDs, body.Value.NewParentID); err != nil {
		return 0, mapDriveErr(err)
	}
	return http.StatusNoContent, nil
}

func (h *DriveHandler) Copy(ctx context.Context, body m.JSON[models.DriveCopyRequest]) ([]models.DriveNode, error) {
	out, err := h.drive.Copy(ctx, body.Value.IDs, body.Value.NewParentID)
	if err != nil {
		return nil, mapDriveErr(err)
	}
	if out == nil {
		out = []models.DriveNode{}
	}
	return out, nil
}

func (h *DriveHandler) Star(ctx context.Context, body m.JSON[models.DriveStarRequest]) (m.StatusCode, error) {
	if err := h.drive.SetStarred(ctx, body.Value.IDs, body.Value.Starred); err != nil {
		return 0, mapDriveErr(err)
	}
	return http.StatusNoContent, nil
}

func (h *DriveHandler) Delete(ctx context.Context, body m.JSON[models.DriveDeleteRequest]) (m.StatusCode, error) {
	if err := h.drive.SoftDelete(ctx, body.Value.IDs); err != nil {
		return 0, mapDriveErr(err)
	}
	return http.StatusNoContent, nil
}

func (h *DriveHandler) Restore(ctx context.Context, body m.JSON[models.DriveRestoreRequest]) (m.StatusCode, error) {
	if err := h.drive.Restore(ctx, body.Value.ID); err != nil {
		return 0, mapDriveErr(err)
	}
	return http.StatusNoContent, nil
}

func (h *DriveHandler) Purge(ctx context.Context, body m.JSON[models.DrivePurgeRequest]) (m.StatusCode, error) {
	if err := h.drive.Purge(ctx, body.Value.IDs); err != nil {
		return 0, mapDriveErr(err)
	}
	return http.StatusNoContent, nil
}

// ---------- download / preview ----------

func (h *DriveHandler) Download(w http.ResponseWriter, r *http.Request) {
	h.serveBlob(w, r, true)
}

func (h *DriveHandler) Preview(w http.ResponseWriter, r *http.Request) {
	h.serveBlob(w, r, false)
}

// Thumbnail serves a 240px JPEG thumbnail for image nodes. Generated lazily
// and cached on disk; returns 404 for non-image / missing nodes.
func (h *DriveHandler) Thumbnail(w http.ResponseWriter, r *http.Request) {
	idStr := r.URL.Query().Get("id")
	id, _ := strconv.ParseInt(idStr, 10, 64)
	if id <= 0 {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}
	path, err := h.drive.Thumbnail(r.Context(), id)
	if err != nil {
		if errors.Is(err, services.ErrDriveNotFound) || errors.Is(err, services.ErrDriveNotImage) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		log.Printf("drive thumb: %v", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	serveThumbFile(w, r, path)
}

func (h *DriveHandler) serveBlob(w http.ResponseWriter, r *http.Request, forceAttachment bool) {
	// Extend write deadline so large file downloads aren't cut off by the
	// global WriteTimeout.
	http.NewResponseController(w).SetWriteDeadline(time.Now().Add(time.Hour))

	idStr := r.URL.Query().Get("id")
	id, _ := strconv.ParseInt(idStr, 10, 64)
	if id <= 0 {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}
	node, err := h.drive.FindByID(r.Context(), id)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	// allowInlineHTML=true only in the authenticated preview path: the user
	// owns the file, so rendering HTML inline is intentional and safe.
	serveStoredDriveBlob(w, r, h.drive, node, forceAttachment, !forceAttachment)
}

func (h *DriveHandler) DownloadZip(w http.ResponseWriter, r *http.Request) {
	// Zip generation + streaming can be slow for large folders; extend the
	// write deadline well beyond the global WriteTimeout.
	http.NewResponseController(w).SetWriteDeadline(time.Now().Add(2 * time.Hour))

	// Multi-select: ?ids=1,2,3 zips an arbitrary selection.
	if idsParam := r.URL.Query().Get("ids"); idsParam != "" {
		ids := parseIDList(idsParam)
		if len(ids) == 0 {
			http.Error(w, "invalid ids", http.StatusBadRequest)
			return
		}
		name := fmt.Sprintf("mote-drive-%s.zip", time.Now().Format("20060102-150405"))
		w.Header().Set("Content-Type", "application/zip")
		w.Header().Set("Content-Disposition",
			fmt.Sprintf("attachment; filename*=UTF-8''%s", url.PathEscape(name)))
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if err := h.drive.ZipNodes(r.Context(), ids, w); err != nil {
			// ZipNodes fails before writing anything when the whole selection
			// is gone — a clean 404 is still possible then.
			if errors.Is(err, services.ErrDriveNotFound) {
				w.Header().Del("Content-Disposition")
				http.Error(w, "not found", http.StatusNotFound)
				return
			}
			log.Printf("zip download failed: %v", err)
		}
		return
	}

	idStr := r.URL.Query().Get("id")
	id, _ := strconv.ParseInt(idStr, 10, 64)
	node, err := h.drive.FindByID(r.Context(), id)
	if err != nil || node.Type != "folder" || node.DeletedAt.Valid {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition",
		fmt.Sprintf("attachment; filename*=UTF-8''%s.zip", url.PathEscape(node.Name)))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if err := h.drive.ZipFolder(r.Context(), id, w); err != nil {
		log.Printf("zip download failed: %v", err)
	}
}

// parseIDList parses a comma-separated id list, ignoring blank/invalid parts.
func parseIDList(s string) []int64 {
	parts := strings.Split(s, ",")
	out := make([]int64, 0, len(parts))
	for _, p := range parts {
		if id, err := strconv.ParseInt(strings.TrimSpace(p), 10, 64); err == nil && id > 0 {
			out = append(out, id)
		}
	}
	return out
}

// ---------- uploads ----------

func (h *DriveHandler) UploadInit(ctx context.Context, body m.JSON[models.DriveUploadInitRequest]) (*models.DriveUploadInitResponse, error) {
	u, err := h.upload.Init(ctx, body.Value)
	if err != nil {
		return nil, mapDriveErr(err)
	}
	return &models.DriveUploadInitResponse{
		UploadID:       u.ID,
		TotalChunks:    u.TotalChunks,
		ChunkSize:      u.ChunkSize,
		ReceivedChunks: []int{},
	}, nil
}

type uploadStatusQuery struct{}

type uploadStatusResponse struct {
	UploadID       string `json:"upload_id"`
	TotalChunks    int    `json:"total_chunks"`
	ChunkSize      int64  `json:"chunk_size"`
	Size           int64  `json:"size"`
	ReceivedChunks []int  `json:"received_chunks"`
	Status         string `json:"status"`
}

func (h *DriveHandler) UploadStatus(r *http.Request, _ m.Query[uploadStatusQuery]) (*uploadStatusResponse, error) {
	id := chi.URLParam(r, "upload_id")
	u, received, err := h.upload.Get(r.Context(), id)
	if err != nil {
		return nil, mapDriveErr(err)
	}
	return &uploadStatusResponse{
		UploadID:       u.ID,
		TotalChunks:    u.TotalChunks,
		ChunkSize:      u.ChunkSize,
		Size:           u.Size,
		ReceivedChunks: received,
		Status:         u.Status,
	}, nil
}

func (h *DriveHandler) UploadChunk(w http.ResponseWriter, r *http.Request) {
	// Each chunk can be up to 16 MiB; extend the read deadline so slow
	// connections aren't cut off by the global ReadTimeout.
	http.NewResponseController(w).SetReadDeadline(time.Now().Add(30 * time.Minute))

	id := chi.URLParam(r, "upload_id")
	idx, err := strconv.Atoi(chi.URLParam(r, "idx"))
	if err != nil {
		http.Error(w, "bad index", http.StatusBadRequest)
		return
	}
	defer r.Body.Close()
	if err := h.upload.PutChunk(r.Context(), id, idx, r.Body); err != nil {
		writeDriveErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *DriveHandler) UploadComplete(w http.ResponseWriter, r *http.Request, body m.JSON[models.DriveUploadCompleteRequest]) (*models.DriveNode, error) {
	// Finalizing streams every chunk into the final blob and hashes it; for
	// large videos this runs well past the global WriteTimeout. Extend the
	// write deadline, mirroring serveBlob / DownloadZip. mint's ResponseWriter
	// implements Unwrap, so the controller reaches the underlying connection.
	if err := http.NewResponseController(w).SetWriteDeadline(time.Now().Add(30 * time.Minute)); err != nil {
		log.Printf("drive: extend write deadline for upload complete: %v", err)
	}

	policy := body.Value.OnCollision
	if policy == "" {
		policy = "ask"
	}
	n, err := h.upload.Complete(r.Context(), body.Value.UploadID, policy)
	if err != nil {
		return nil, mapDriveErr(err)
	}
	return n, nil
}

func (h *DriveHandler) UploadCancel(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "upload_id")
	if err := h.upload.Cancel(r.Context(), id); err != nil {
		writeDriveErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---------- shares ----------

type shareDTO struct {
	ID          int64  `json:"id"`
	NodeID      int64  `json:"node_id"`
	HasPassword bool   `json:"has_password"`
	ExpiresAt   *int64 `json:"expires_at"`
	CreatedAt   int64  `json:"created_at"`
	URL         string `json:"url,omitempty"`
	Token       string `json:"token,omitempty"`
}

func (h *DriveHandler) CreateShare(r *http.Request, body m.JSON[models.DriveShareCreateRequest]) (*shareDTO, error) {
	sh, err := h.share.Create(r.Context(), body.Value.NodeID, body.Value.Password, body.Value.ExpiresAt)
	if err != nil {
		return nil, mapDriveErr(err)
	}
	dto := toShareDTO(sh)
	dto.URL = h.shareURL(r, sh.Token)
	dto.Token = sh.Token
	return dto, nil
}

func (h *DriveHandler) ListShares(ctx context.Context, q m.Query[idQuery]) ([]shareDTO, error) {
	rows, err := h.share.ListByNode(ctx, q.Value.ID)
	if err != nil {
		return nil, mapDriveErr(err)
	}
	out := make([]shareDTO, 0, len(rows))
	for i := range rows {
		out = append(out, *toShareDTO(&rows[i]))
	}
	return out, nil
}

func (h *DriveHandler) RevokeShare(ctx context.Context, body m.JSON[models.DriveShareRevokeRequest]) (m.StatusCode, error) {
	if err := h.share.Revoke(ctx, body.Value.ShareID); err != nil {
		return 0, mapDriveErr(err)
	}
	return http.StatusNoContent, nil
}

type sharedItemDTO struct {
	ID          int64  `json:"id"`
	NodeID      int64  `json:"node_id"`
	ParentID    *int64 `json:"parent_id"`
	HasPassword bool   `json:"has_password"`
	ExpiresAt   *int64 `json:"expires_at"`
	CreatedAt   int64  `json:"created_at"`
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	Path        string `json:"path"`
	URL         string `json:"url,omitempty"`
	NodeType    string `json:"node_type"`
	MimeType    string `json:"mime_type,omitempty"`
}

type sharesAllQuery struct {
	IncludeExpired bool `schema:"include_expired"`
}

func (h *DriveHandler) ListAllShares(r *http.Request, q m.Query[sharesAllQuery]) ([]sharedItemDTO, error) {
	rows, err := h.share.ListAll(r.Context(), q.Value.IncludeExpired)
	if err != nil {
		return nil, mapDriveErr(err)
	}
	out := make([]sharedItemDTO, 0, len(rows))
	for i := range rows {
		row := &rows[i]
		dto := sharedItemDTO{
			ID:          row.ID,
			NodeID:      row.NodeID,
			HasPassword: row.HasPassword,
			CreatedAt:   row.CreatedAt,
			Name:        row.Name,
			Size:        row.Size,
			Path:        row.Path,
			NodeType:    row.NodeType,
		}
		n := models.DriveNode{Type: row.NodeType, Name: row.Name}
		dto.MimeType = n.MimeType()
		if row.StoredToken.Valid {
			dto.URL = h.shareURL(r, row.StoredToken.String)
		}
		if row.ParentID.Valid {
			v := row.ParentID.Int64
			dto.ParentID = &v
		}
		if row.ExpiresAt.Valid {
			v := row.ExpiresAt.Int64
			dto.ExpiresAt = &v
		}
		out = append(out, dto)
	}
	return out, nil
}

func toShareDTO(sh *models.DriveShare) *shareDTO {
	dto := &shareDTO{
		ID:          sh.ID,
		NodeID:      sh.NodeID,
		HasPassword: sh.HasPassword || sh.PasswordHash.Valid,
		CreatedAt:   sh.CreatedAt,
	}
	if sh.ExpiresAt.Valid {
		v := sh.ExpiresAt.Int64
		dto.ExpiresAt = &v
	}
	return dto
}

func (h *DriveHandler) shareURL(r *http.Request, token string) string {
	scheme := "http"
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		scheme = "https"
	}
	host := r.Host
	if fwd := r.Header.Get("X-Forwarded-Host"); fwd != "" {
		host = fwd
	}
	return fmt.Sprintf("%s://%s/shared-files/%s", scheme, host, token)
}

// ---------- helpers ----------

// mustForceAttachment forces attachment for inline-unsafe content types.
func mustForceAttachment(mt, ext string) bool {
	mt = strings.ToLower(mt)
	ext = strings.ToLower(strings.TrimPrefix(ext, "."))
	switch ext {
	case "html", "htm", "svg", "xhtml", "xml", "js", "mjs":
		return true
	}
	if strings.HasPrefix(mt, "text/html") || strings.Contains(mt, "javascript") ||
		strings.HasPrefix(mt, "image/svg") {
		return true
	}
	if mt == "" || mt == "application/octet-stream" {
		return true
	}
	return false
}

// isHTMLContent reports whether the node is an HTML document by MIME type or
// file extension. Used to decide when to allow inline rendering in the preview.
func isHTMLContent(mt, ext string) bool {
	ext = strings.ToLower(strings.TrimPrefix(ext, "."))
	return strings.HasPrefix(strings.ToLower(mt), "text/html") ||
		ext == "html" || ext == "htm"
}

func mapDriveErr(err error) error {
	switch {
	case errors.Is(err, services.ErrDriveNotFound), errors.Is(err, services.ErrUploadNotFound),
		errors.Is(err, services.ErrShareNotFound):
		return e.NotFound(err.Error())
	case errors.Is(err, services.ErrDriveNameConflict):
		return m.HTTPError{Code: http.StatusConflict, Err: "conflict", Message: err.Error()}
	case errors.Is(err, services.ErrDriveCycle), errors.Is(err, services.ErrDriveNotFolder),
		errors.Is(err, services.ErrDriveInvalidName), errors.Is(err, services.ErrDriveInvalidParent),
		errors.Is(err, services.ErrUploadChunkSize), errors.Is(err, services.ErrUploadChunkOOR),
		errors.Is(err, services.ErrUploadIncomplete), errors.Is(err, services.ErrUploadFinalSize),
		errors.Is(err, services.ErrUploadTooLarge), errors.Is(err, services.ErrUploadInvalidRequest),
		errors.Is(err, services.ErrShareInvalidNode):
		return e.BadRequest(err.Error())
	case errors.Is(err, services.ErrShareExpired):
		return m.HTTPError{Code: http.StatusGone, Err: "gone", Message: err.Error()}
	case errors.Is(err, services.ErrShareWrongPassword):
		return e.Unauthorized(err.Error())
	}
	return err
}

func writeDriveErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, services.ErrUploadNotFound):
		http.Error(w, err.Error(), http.StatusNotFound)
	case errors.Is(err, services.ErrUploadChunkSize), errors.Is(err, services.ErrUploadChunkOOR),
		errors.Is(err, services.ErrUploadInvalidRequest):
		http.Error(w, err.Error(), http.StatusBadRequest)
	default:
		log.Printf("drive: %v", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
	}
}
