package services

import (
	"archive/zip"
	"context"
	"errors"
	"io"
	"os"
	"path"
	"strings"
	"time"
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
