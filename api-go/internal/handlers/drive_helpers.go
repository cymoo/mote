package handlers

import (
	"encoding/json"
	"io"
)

func encodeJSON(w io.Writer, body any) error {
	return json.NewEncoder(w).Encode(body)
}
