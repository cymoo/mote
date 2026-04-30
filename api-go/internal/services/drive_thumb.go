package services

import (
	"context"
	"errors"
	"fmt"
	"image/jpeg"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/disintegration/imaging"
)

// thumbWidth is the long-edge in pixels for drive thumbnails.
const thumbWidth = 240

// ErrDriveNotImage is returned by Thumbnail when the requested file isn't an image.
var ErrDriveNotImage = errors.New("not an image")

// imageExts are the extensions we generate thumbnails for. Limited to formats
// `imaging` decodes safely; HEIC etc. are skipped.
var imageExts = map[string]struct{}{
	".jpg": {}, ".jpeg": {}, ".png": {}, ".webp": {}, ".gif": {}, ".bmp": {}, ".tiff": {},
}

// thumbLocks serialises generation of the same thumbnail so concurrent requests
// don't decode/encode the same image twice.
var thumbLocks sync.Map // string -> *sync.Mutex

func keyLock(key string) *sync.Mutex {
	if v, ok := thumbLocks.Load(key); ok {
		return v.(*sync.Mutex)
	}
	mu := &sync.Mutex{}
	actual, _ := thumbLocks.LoadOrStore(key, mu)
	return actual.(*sync.Mutex)
}

// Thumbnail returns the absolute path to a JPEG thumbnail for an image node.
// Generates the thumbnail lazily on first request and caches it next to the
// blob (under drive/_thumbs/). Returns ErrDriveNotImage for non-image nodes.
func (s *DriveService) Thumbnail(ctx context.Context, id int64) (string, error) {
	n, err := s.FindByID(ctx, id)
	if err != nil {
		return "", err
	}
	if n.Type != "file" || !n.BlobPath.Valid || n.DeletedAt.Valid {
		return "", ErrDriveNotFound
	}
	ext := strings.ToLower(filepath.Ext(n.Name))
	if _, ok := imageExts[ext]; !ok {
		return "", ErrDriveNotImage
	}

	srcAbs := s.BlobAbsPath(n.BlobPath.String)
	thumbsDir := filepath.Join(s.config.BasePath, "drive", "_thumbs")
	if err := os.MkdirAll(thumbsDir, 0755); err != nil {
		return "", err
	}
	thumbAbs := filepath.Join(thumbsDir, filepath.Base(n.BlobPath.String)+".jpg")

	if st, err := os.Stat(thumbAbs); err == nil && st.Size() > 0 {
		return thumbAbs, nil
	}

	mu := keyLock(thumbAbs)
	mu.Lock()
	defer mu.Unlock()
	// Double-check after acquiring the lock.
	if st, err := os.Stat(thumbAbs); err == nil && st.Size() > 0 {
		return thumbAbs, nil
	}

	img, err := imaging.Open(srcAbs, imaging.AutoOrientation(true))
	if err != nil {
		return "", fmt.Errorf("decode %s: %w", srcAbs, err)
	}

	bounds := img.Bounds()
	w, h := bounds.Dx(), bounds.Dy()
	if w == 0 || h == 0 {
		return "", fmt.Errorf("zero-dimension image")
	}
	// Don't upscale: if already small enough, just re-encode as JPEG.
	tw := thumbWidth
	if w < tw {
		tw = w
	}
	th := h * tw / w
	thumb := imaging.Resize(img, tw, th, imaging.Lanczos)

	tmp := thumbAbs + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return "", err
	}
	if err := jpeg.Encode(f, thumb, &jpeg.Options{Quality: 82}); err != nil {
		f.Close()
		_ = os.Remove(tmp)
		return "", err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	if err := os.Rename(tmp, thumbAbs); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	return thumbAbs, nil
}

// PurgeThumb removes the cached thumbnail for a blob (best-effort). Called
// when the underlying file is overwritten/deleted.
func (s *DriveService) PurgeThumb(blobPath string) {
	if blobPath == "" {
		return
	}
	thumbAbs := filepath.Join(s.config.BasePath, "drive", "_thumbs",
		filepath.Base(blobPath)+".jpg")
	_ = os.Remove(thumbAbs)
}
