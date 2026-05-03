package handlers

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"

	m "github.com/cymoo/mint"
	e "github.com/cymoo/mote/internal/errors"
	"github.com/cymoo/mote/internal/models"
	"github.com/cymoo/mote/internal/services"

	"github.com/cymoo/mote/pkg/fulltext"
)

type PostHandler struct {
	postService *services.PostService
	tagService  *services.TagService
	fts         *fulltext.FullTextSearch
}

func NewPostHandler(postService *services.PostService, tagService *services.TagService, fts *fulltext.FullTextSearch) *PostHandler {
	return &PostHandler{postService: postService, tagService: tagService, fts: fts}
}

func (h *PostHandler) HelloWorld() string {
	return "hello world"
}

// SearchPosts handles searching posts with full-text search
// It highlights matched tokens in the post content and orders results by relevance score.
// Returns a PostPagination containing the matched posts.
// If no posts match, returns an empty PostPagination.
// The search supports partial matching and limits the number of results.
func (h *PostHandler) SearchPosts(r *http.Request, query m.Query[models.SearchRequest]) (*models.PostPagination, error) {
	ctx := r.Context()

	// Perform the search using full-text search service
	tokens, results, err := h.fts.Search(ctx, query.Value.Query, query.Value.Partial, query.Value.Limit)
	if err != nil {
		log.Printf("error searching posts with query %q: %v", query.Value.Query, err)
		return nil, e.InternalError()
	}

	log.Printf("results: %#v", results)
	if len(results) == 0 {
		return &models.PostPagination{
			Posts:  []models.Post{},
			Cursor: -1,
			Size:   0,
		}, nil
	}

	// Build a map from ID to Score
	idToScore := make(map[int64]float64, len(results))
	ids := make([]int64, 0, len(results))

	for _, result := range results {
		idToScore[result.ID] = result.Score
		ids = append(ids, result.ID)
	}

	// Get posts by IDs
	posts, err := h.postService.FindByIDs(ctx, ids)
	if err != nil {
		log.Printf("error finding posts with ids %v: %v", ids, err)
		return nil, err
	}

	// Process each post's content and score
	for i := range posts {
		score, exists := idToScore[posts[i].ID]
		if exists {
			// Highlight all occurrences of tokens in the content
			posts[i].Content = markTokensInHtml(posts[i].Content, tokens)
			posts[i].Score = &score
		}
	}

	// Order by score desc
	sort.Slice(posts, func(i, j int) bool {
		scoreI, existsI := idToScore[posts[i].ID]
		scoreJ, existsJ := idToScore[posts[j].ID]

		if !existsI && !existsJ {
			return false
		}
		if !existsI {
			return false
		}
		if !existsJ {
			return true
		}
		return scoreI > scoreJ
	})

	size := int64(len(posts))

	return &models.PostPagination{
		Posts:  posts,
		Cursor: -1,
		Size:   size,
	}, nil
}

// GetPosts retrieves posts with filtering and pagination
// It returns a PostPagination containing the posts and pagination info.
func (h *PostHandler) GetPosts(r *http.Request, query m.Query[models.FilterPostRequest]) (*models.PostPagination, error) {
	posts, err := h.postService.Filter(r.Context(), query.Value, 10)
	if err != nil {
		log.Printf("error getting posts: %v", err)
		return nil, e.InternalError()
	}

	// Determine the new cursor based on the last post's CreatedAt
	size := len(posts)
	cursor := int64(-1)
	if size > 0 {
		cursor = posts[size-1].CreatedAt
	}

	return &models.PostPagination{
		Posts:  posts,
		Cursor: cursor,
		Size:   int64(size),
	}, nil
}

// GetPost retrieves a single post by ID
// It returns the post if found, otherwise returns a NotFound error.
func (h *PostHandler) GetPost(r *http.Request, query m.Query[models.ID]) (*models.Post, error) {
	id := query.Value.ID
	post, err := h.postService.FindByID(r.Context(), id)
	if err != nil {
		log.Printf("error getting post %d: %v", id, err)
		return nil, e.InternalError()
	}

	if post == nil {
		return nil, e.NotFound("post not found")
	}
	return post, nil
}

// GetStats retrieves statistics about posts and tags
// It returns a PostStats containing counts of posts, tags, and active days.
func (h *PostHandler) GetStats(r *http.Request) (*models.PostStats, error) {
	postCount, err := h.postService.GetCount(r.Context())
	if err != nil {
		log.Printf("error getting post count: %v", err)
		return nil, err
	}

	tagCount, err := h.tagService.GetCount(r.Context())
	if err != nil {
		log.Printf("error getting tag count: %v", err)
		return nil, err
	}

	dayCount, err := h.postService.GetActiveDays(r.Context())
	if err != nil {
		log.Printf("error getting active days: %v", err)
		return nil, err
	}

	return &models.PostStats{
		PostCount: postCount,
		TagCount:  tagCount,
		DayCount:  dayCount,
	}, nil
}

// GetDailyCounts retrieves daily post counts within a date range
// It returns a slice of counts corresponding to each day in the range.
// If the date range is invalid, it returns a BadRequest error.
func (h *PostHandler) GetDailyCounts(r *http.Request, query m.Query[models.DateRange]) ([]int64, error) {
	startDateStr := query.Value.StartDate
	endDateStr := query.Value.EndDate
	startDate, err := time.Parse(time.DateOnly, startDateStr)
	if err != nil {
		return nil, e.BadRequest(fmt.Sprintf("invalid date '%s': must be in YYYY-MM-DD format", startDateStr))
	}

	endDate, err := time.Parse(time.DateOnly, endDateStr)
	if err != nil {
		return nil, e.BadRequest(fmt.Sprintf("invalid date '%s': must be in YYYY-MM-DD format", endDateStr))
	}

	// Include the entire end date by adding one day
	endDate = endDate.AddDate(0, 0, 1)

	if endDate.Before(startDate) {
		return nil, e.BadRequest("end_date must be after start_date")
	}

	counts, err := h.postService.GetDailyCounts(r.Context(), startDate, endDate, query.Value.Offset*60)
	if err != nil {
		log.Printf("error getting daily post counts: %v", err)
		return nil, err
	}
	return counts, nil
}

// CreatePost creates a new post
// It returns the created post's ID.
// After creation, it indexes the post content in the background.
func (h *PostHandler) CreatePost(r *http.Request, body m.JSON[models.CreatePostRequest]) (*models.CreateResponse, error) {
	rv, err := h.postService.Create(r.Context(), body.Value)
	if err != nil {
		log.Printf("error creating post: %v", err)
		return nil, err
	}

	go func() {
		ctx := context.Background()
		if err := h.fts.Index(ctx, rv.ID, body.Value.Content); err != nil {
			log.Printf("error indexing post %d: %v", rv.ID, err)
		}
	}()

	return rv, nil
}

// UpdatePost updates an existing post
// It returns a 204 No Content status on success.
// If the post content is updated, it reindexes the content in the background.
func (h *PostHandler) UpdatePost(r *http.Request, body m.JSON[models.UpdatePostRequest]) (m.StatusCode, error) {
	id := body.Value.ID
	err := h.postService.Update(r.Context(), body.Value)
	if err != nil {
		log.Printf("error updating post %d: %v", id, err)
		return 0, err
	}

	if body.Value.Content != nil {
		go func() {
			ctx := context.Background()
			if err := h.fts.Reindex(ctx, id, *body.Value.Content); err != nil {
				log.Printf("error reindexing post %d: %v", id, err)
			}
		}()
	}

	return 204, nil
}

// DeletePost deletes a post
// If Hard is true, it permanently deletes the post and removes it from the index.
// If Hard is false, it marks the post as deleted.
// Returns a 204 No Content status on success.
func (h *PostHandler) DeletePost(r *http.Request, payload m.JSON[models.DeletePostRequest]) (m.StatusCode, error) {
	id := payload.Value.ID

	if payload.Value.Hard {
		err := h.postService.HardDelete(r.Context(), id)
		if err != nil {
			log.Printf("error hard deleting post %d: %v", id, err)
			return 0, err
		}

		go func() {
			ctx := context.Background()
			if err := h.fts.Deindex(ctx, id); err != nil {
				log.Printf("error deleting post %d from index: %v", id, err)
			}
		}()

	} else {
		err := h.postService.Delete(r.Context(), id)
		if err != nil {
			log.Printf("error deleting post %d: %v", id, err)
			return 0, err
		}
	}

	return 204, nil
}

// RestorePost restores a soft-deleted post
// It returns a 204 No Content status on success.
func (h *PostHandler) RestorePost(r *http.Request, payload m.JSON[models.ID]) (m.StatusCode, error) {
	id := payload.Value.ID
	err := h.postService.Restore(r.Context(), id)
	if err != nil {
		log.Printf("error restoring post %d: %v", id, err)
		return 0, err
	}
	return 204, nil
}

// ClearPosts permanently deletes all soft-deleted posts
// It returns a 204 No Content status on success.
// After clearing, it removes the posts from the full-text index in the background.
func (h *PostHandler) ClearPosts(r *http.Request) (m.StatusCode, error) {
	ids, err := h.postService.ClearAll(r.Context())
	if err != nil {
		log.Printf("error clearing posts: %v", err)
		return 0, err
	}
	log.Printf("cleared posts: %v", ids)

	go func() {
		ctx := context.Background()
		for _, id := range ids {
			if err := h.fts.Deindex(ctx, id); err != nil {
				log.Printf("error deleting post %d from index: %v", id, err)
			}
		}
	}()

	return 204, nil
}

// Helper functions

// IsChineseCharacter checks if a rune is a Chinese character
func isChineseCharacter(c rune) bool {
	return c >= '\u4e00' && c <= '\u9fff'
}

// markTokensInHtml marks all occurrences of the given tokens in the HTML string
// by wrapping them with <mark> tags, while preserving existing HTML tags.
func markTokensInHtml(html string, tokens []string) string {
	if len(tokens) == 0 {
		return html
	}

	// Sort tokens by length in descending order to match longer tokens first
	sortedTokens := make([]string, len(tokens))
	copy(sortedTokens, tokens)
	sort.Slice(sortedTokens, func(i, j int) bool {
		return len(sortedTokens[i]) > len(sortedTokens[j])
	})

	// Build regex pattern to match any of the tokens
	patterns := make([]string, len(sortedTokens))
	for i, token := range sortedTokens {
		patterns[i] = tokenToPattern(token)
	}

	// Combine HTML tag pattern with token patterns
	pattern := `(<[^>]*>)|(` + strings.Join(patterns, "|") + `)`
	re, err := regexp.Compile(pattern)
	if err != nil {
		// In case of regex compilation error, return original HTML
		return html
	}

	// Replace matches with highlighted versions, preserving HTML tags
	result := re.ReplaceAllStringFunc(html, func(match string) string {
		// If it's an HTML tag, return as is
		if len(match) > 0 && match[0] == '<' && match[len(match)-1] == '>' {
			return match
		}
		// Otherwise, highlight the matched token
		return "<mark>" + match + "</mark>"
	})

	return result
}

// tokenToPattern converts a token into a regex pattern for matching
func tokenToPattern(token string) string {
	// Escape special regex characters in the token
	escaped := regexp.QuoteMeta(token)

	// Check if the token contains any Chinese characters
	hasChinese := false
	for _, c := range token {
		if isChineseCharacter(c) {
			hasChinese = true
			break
		}
	}

	if hasChinese {
		return escaped
	}

	// Check if it's purely alphanumeric or spaces
	isPureAlphanumeric := true
	for _, c := range token {
		if !unicode.IsLetter(c) && !unicode.IsNumber(c) && !unicode.IsSpace(c) {
			isPureAlphanumeric = false
			break
		}
	}

	if isPureAlphanumeric {
		return `\b` + escaped + `\b`
	}

	return escaped
}
