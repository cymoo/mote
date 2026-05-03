package handlers

import (
	"fmt"
	"log"
	"net/http"
	"strings"

	m "github.com/cymoo/mint"
	e "github.com/cymoo/mote/internal/errors"
	"github.com/cymoo/mote/internal/models"
	"github.com/cymoo/mote/internal/services"
)

type TagHandler struct {
	tagService *services.TagService
}

func NewTagHandler(tagService *services.TagService) *TagHandler {
	return &TagHandler{tagService: tagService}
}

// GetTags retrieves all tags with their post counts
func (h *TagHandler) GetTags(r *http.Request) ([]models.TagWithPostCount, error) {
	tags, err := h.tagService.GetAllWithPostCount(r.Context())
	if err != nil {
		log.Printf("error getting tags: %v", err)
		return nil, err
	}
	return tags, nil
}

// RenameTag renames or merges a tag
// It checks for invalid hierarchy and returns a BadRequest error if detected.
// The old tag name is replaced with the new tag name in all associated posts.
// If the new tag name already exists, the tags are merged.
// Returns a 204 No Content status on success.
func (h *TagHandler) RenameTag(r *http.Request, payload m.JSON[models.RenameTagRequest]) (m.StatusCode, error) {
	oldName := payload.Value.Name
	newName := payload.Value.NewName

	// Check for invalid hierarchy
	if strings.HasPrefix(newName, oldName+"/") {
		return 0, e.BadRequest(fmt.Sprintf("cannot move %q to a subtag of itself %q", oldName, newName))
	}

	// Perform rename or merge
	err := h.tagService.RenameOrMerge(r.Context(), oldName, newName)
	if err != nil {
		log.Printf("error renaming tag %q to %q: %v", oldName, newName, err)
		return 0, err
	}
	return m.StatusCode(204), nil
}

// DeleteTag deletes a tag and removes its association from all posts
// It returns a 204 No Content status on success.
func (h *TagHandler) DeleteTag(r *http.Request, payload m.JSON[models.Name]) (m.StatusCode, error) {
	tagName := payload.Value.Name
	err := h.tagService.DeleteAssociatedPosts(r.Context(), tagName)
	if err != nil {
		log.Printf("error delete tag %q: %v", tagName, err)
		return 0, err
	}
	return m.StatusCode(204), nil
}

// StickTag sets or unsets a tag as sticky
// It returns a 204 No Content status on success.
func (h *TagHandler) StickTag(r *http.Request, payload m.JSON[models.StickyTagRequest]) (m.StatusCode, error) {
	tagName := payload.Value.Name
	err := h.tagService.InsertOrUpdate(r.Context(), tagName, payload.Value.Sticky)
	if err != nil {
		log.Printf("error updating tag %q: %v", tagName, err)
		return 0, err
	}
	return m.StatusCode(204), nil
}
