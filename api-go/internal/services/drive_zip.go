package services

import (
	"archive/zip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
	"time"

	"github.com/cymoo/mote/internal/models"
)

// ZipFolder writes a streaming zip archive of folderID to w.
// Returns ErrDriveNotFound if folderID isn't a folder.
func (s *DriveService) ZipFolder(ctx context.Context, folderID int64, w io.Writer) error {
	root, err := s.FindByID(ctx, folderID)
	if err != nil {
		return err
	}
	if root.Type != "folder" || root.DeletedAt.Valid {
		return ErrDriveNotFound
	}
	descendants, err := s.CollectDescendants(ctx, folderID)
	if err != nil {
		return err
	}

	zw := zip.NewWriter(w)
	defer zw.Close()

	now := time.Now()
	seen := map[string]struct{}{}
	for _, d := range descendants {
		if d.ID == folderID {
			continue // skip the root folder name itself
		}
		// Strip the root prefix so the archive contents start at depth 1.
		rel := strings.TrimPrefix(d.RelPath, root.Name)
		rel = strings.TrimPrefix(rel, "/")
		rel = sanitizeZipPath(rel)
		if rel == "" {
			continue
		}
		if _, dup := seen[rel]; dup {
			continue
		}
		seen[rel] = struct{}{}

		hdr := &zip.FileHeader{
			Name:     rel,
			Method:   zip.Deflate,
			Modified: now,
		}
		if d.Type == "folder" {
			hdr.Name = rel + "/"
			if _, err := zw.CreateHeader(hdr); err != nil {
				return err
			}
			continue
		}

		fw, err := zw.CreateHeader(hdr)
		if err != nil {
			return err
		}
		if !d.BlobPath.Valid {
			continue
		}
		f, err := os.Open(s.BlobAbsPath(d.BlobPath.String))
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return err
		}
		_, err = io.Copy(fw, f)
		f.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

// sanitizeZipPath strips ".." and absolute-path components from a zip entry name.
func sanitizeZipPath(p string) string {
	parts := strings.Split(p, "/")
	out := parts[:0]
	for _, seg := range parts {
		seg = strings.TrimSpace(seg)
		if seg == "" || seg == "." || seg == ".." {
			continue
		}
		out = append(out, seg)
	}
	return path.Clean(strings.Join(out, "/"))
}

// ZipNodes streams a zip archive of the given nodes to w. Unlike ZipFolder —
// which strips the root folder's own name — selected folders appear as
// top-level directories and selected files as top-level entries. Ids nested
// under other selected ids are skipped (their content arrives via the
// ancestor). Same-named top-level entries get a "name (1)" suffix rather than
// being silently dropped: a multi-select from search results can legitimately
// pick same-named nodes from different folders.
//
// Returns ErrDriveNotFound before writing anything when no valid node remains,
// so the handler can still send a clean 404.
func (s *DriveService) ZipNodes(ctx context.Context, ids []int64, w io.Writer) error {
	seenIDs := make(map[int64]struct{}, len(ids))
	uniq := make([]int64, 0, len(ids))
	for _, id := range ids {
		if _, dup := seenIDs[id]; dup {
			continue
		}
		seenIDs[id] = struct{}{}
		uniq = append(uniq, id)
	}

	nested, err := s.nestedSelections(ctx, uniq)
	if err != nil {
		return err
	}

	targets := make([]*models.DriveNode, 0, len(uniq))
	for _, id := range uniq {
		if _, drop := nested[id]; drop {
			continue
		}
		n, err := s.FindByID(ctx, id)
		if err != nil {
			if errors.Is(err, ErrDriveNotFound) {
				continue
			}
			return err
		}
		if n.DeletedAt.Valid {
			continue
		}
		targets = append(targets, n)
	}
	if len(targets) == 0 {
		return ErrDriveNotFound
	}

	zw := zip.NewWriter(w)
	defer zw.Close()

	now := time.Now()
	topLevel := map[string]struct{}{}
	for _, root := range targets {
		if root.Type == "file" {
			name := uniqueTopLevel(topLevel, sanitizeZipPath(root.Name))
			if name == "" || !root.BlobPath.Valid {
				continue
			}
			fw, err := zw.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate, Modified: now})
			if err != nil {
				return err
			}
			if err := copyBlobInto(fw, s.BlobAbsPath(root.BlobPath.String)); err != nil {
				return err
			}
			continue
		}

		descendants, err := s.CollectDescendants(ctx, root.ID)
		if err != nil {
			return err
		}
		topName := uniqueTopLevel(topLevel, sanitizeZipPath(root.Name))
		if topName == "" {
			continue
		}
		seen := map[string]struct{}{}
		for _, d := range descendants {
			var rel string
			if d.ID == root.ID {
				rel = topName
			} else {
				// RelPath starts with the root's own name; swap it for the
				// (possibly suffixed) reserved top-level name.
				sub := strings.TrimPrefix(d.RelPath, root.Name)
				sub = sanitizeZipPath(strings.TrimPrefix(sub, "/"))
				if sub == "" {
					continue
				}
				rel = topName + "/" + sub
			}
			if _, dup := seen[rel]; dup {
				continue
			}
			seen[rel] = struct{}{}

			hdr := &zip.FileHeader{Name: rel, Method: zip.Deflate, Modified: now}
			if d.Type == "folder" {
				hdr.Name = rel + "/"
				if _, err := zw.CreateHeader(hdr); err != nil {
					return err
				}
				continue
			}
			fw, err := zw.CreateHeader(hdr)
			if err != nil {
				return err
			}
			if !d.BlobPath.Valid {
				continue
			}
			if err := copyBlobInto(fw, s.BlobAbsPath(d.BlobPath.String)); err != nil {
				return err
			}
		}
	}
	return nil
}

// nestedSelections returns the subset of ids that are strict descendants of
// other ids in the same selection (possible when multi-selecting from search
// results, where ancestors and descendants can appear side by side).
func (s *DriveService) nestedSelections(ctx context.Context, ids []int64) (map[int64]struct{}, error) {
	out := map[int64]struct{}{}
	if len(ids) < 2 {
		return out, nil
	}
	idsJSON, err := json.Marshal(ids)
	if err != nil {
		return nil, err
	}
	var nested []int64
	if err := s.db.SelectContext(ctx, &nested, `
WITH RECURSIVE selected(id) AS (
  SELECT value FROM json_each(?)
),
descendants(id) AS (
  SELECT n.id FROM drive_nodes n WHERE n.parent_id IN (SELECT id FROM selected)
  UNION ALL
  SELECT n.id FROM drive_nodes n JOIN descendants d ON n.parent_id = d.id
)
SELECT id FROM selected WHERE id IN (SELECT id FROM descendants)`, string(idsJSON)); err != nil {
		return nil, err
	}
	for _, id := range nested {
		out[id] = struct{}{}
	}
	return out, nil
}

// uniqueTopLevel reserves a unique top-level entry name, suffixing
// "stem (1).ext" style on collision.
func uniqueTopLevel(seen map[string]struct{}, name string) string {
	if name == "" {
		return ""
	}
	cand := name
	for i := 1; ; i++ {
		if _, taken := seen[cand]; !taken {
			seen[cand] = struct{}{}
			return cand
		}
		ext := path.Ext(name)
		stem := strings.TrimSuffix(name, ext)
		cand = fmt.Sprintf("%s (%d)%s", stem, i, ext)
	}
}

// copyBlobInto streams a stored blob into a zip entry writer; a missing blob
// file is skipped silently (matches ZipFolder's behavior).
func copyBlobInto(fw io.Writer, absPath string) error {
	f, err := os.Open(absPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	defer f.Close()
	_, err = io.Copy(fw, f)
	return err
}
