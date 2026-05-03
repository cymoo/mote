package handlers

import (
	"log"
	"net/http"

	m "github.com/cymoo/mint"
	e "github.com/cymoo/mote/internal/errors"
	"github.com/cymoo/mote/internal/models"
	"github.com/cymoo/mote/internal/services"
)

type UploadHandler struct {
	uploadService *services.UploadService
}

func NewUploadHandler(uploadService *services.UploadService) *UploadHandler {
	return &UploadHandler{uploadService: uploadService}
}

// UploadFile handles file uploads
// It processes the uploaded file and returns its FileInfo.
// Returns a BadRequest error if the file is invalid.
func (h *UploadHandler) UploadFile(r *http.Request) (*models.FileInfo, error) {
	file, header, err := r.FormFile("file")
	if err != nil {
		return nil, e.BadRequest()
	}

	defer file.Close()

	if header.Filename == "" {
		return nil, e.NotFound("invalid upload file name")
	}

	fileInfo, err := h.uploadService.UploadFile(header)
	if err != nil {
		log.Printf("error handling uploaded file: %v", err)
		return nil, err
	}
	return fileInfo, nil
}

// SimpleFileForm returns a simple HTML form for file upload
// This is useful for testing file uploads via a web browser.
func (h *UploadHandler) SimpleFileForm() m.HTML {
	return `<!doctype html>
  <html>
    <head>
      <title>Upload file</title>
      <meta charset="utf-8">
    </head>
    <body>
      <form action="" method="post" enctype="multipart/form-data">
        <input type="file" name="file" multiple>
          <button type="submit">Upload</button>
        </form>
    </body>
  </html>`
}
