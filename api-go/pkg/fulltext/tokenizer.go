package fulltext

import (
	"regexp"
	"strings"
	"sync"

	t "github.com/cymoo/mote/pkg/util/types"
	"github.com/go-ego/gse"
)

var (
	punctuationRegex = regexp.MustCompile(`\p{P}`)
	htmlTagRegex     = regexp.MustCompile(`<[^>]*>`)
	stopWords        = t.NewSet(
		"a", "an", "and", "are", "as", "at", "be", "by",
		"can", "for", "from", "have", "if", "in", "is",
		"it", "may", "not", "of", "on", "or", "tbd",
		"that", "the", "this", "to", "us", "we", "when",
		"will", "with", "yet", "you", "your",
		"的", "了", "和", "着", "与",
	)
)

// Tokenizer interface for text tokenization
type Tokenizer interface {
	Cut(text string) []string
	Analyze(text string) []string
}

// GseTokenizer implements Tokenizer using gse
type GseTokenizer struct {
	seg  *gse.Segmenter
	once sync.Once
}

// NewGseTokenizer creates a new GseTokenizer
func NewGseTokenizer(dictPaths ...string) *GseTokenizer {
	tokenizer := &GseTokenizer{}
	tokenizer.init(dictPaths...)
	return tokenizer
}

// init initializes the gse segmenter
func (g *GseTokenizer) init(dictPaths ...string) {
	g.once.Do(func() {
		g.seg = new(gse.Segmenter)
		if len(dictPaths) > 0 {
			// Load custom dictionaries if provided
			g.seg.LoadDict(dictPaths...)
		} else {
			// Load default dictionaries
			g.seg.LoadDictEmbed()
		}
	})
}

// Cut tokenizes text into words using search mode
func (g *GseTokenizer) Cut(text string) []string {
	return g.seg.Cut(text, true)
}

// Analyze performs full text analysis with preprocessing
func (g *GseTokenizer) Analyze(text string) []string {
	// Remove HTML tags
	text = htmlTagRegex.ReplaceAllString(text, " ")

	// Remove punctuation
	text = punctuationRegex.ReplaceAllString(text, " ")

	// Tokenize
	tokens := g.Cut(text)

	// Filter and normalize
	result := make([]string, 0, len(tokens))
	for _, token := range tokens {
		token = strings.ToLower(strings.TrimSpace(token))
		token = strings.TrimSpace(token)
		if token != "" { // Filter single characters
			if !stopWords.Contains(token) {
				result = append(result, token)
			}
		}
	}

	return result
}

// LoadDict reloads dictionary
func (g *GseTokenizer) LoadDict(dictPaths ...string) error {
	return g.seg.LoadDict(dictPaths...)
}

// Close is kept for interface compatibility (gse doesn't need explicit cleanup)
func (g *GseTokenizer) Close() {
	// gse doesn't require explicit resource cleanup
}
