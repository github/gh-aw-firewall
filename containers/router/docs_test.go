package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// TestDocumentationLinksStayInsideTheProject checks that relative links in the project's
// Markdown files resolve to files inside the project.
func TestDocumentationLinksStayInsideTheProject(t *testing.T) {
	root, err := filepath.Abs(".")
	if err != nil {
		t.Fatal(err)
	}
	documents, _ := filepath.Glob(filepath.Join(root, "*.md"))
	more, _ := filepath.Glob(filepath.Join(root, "testdata", "*", "*.md"))
	link := regexp.MustCompile(`\]\(([^)]+)\)`)
	for _, document := range append(documents, more...) {
		data, err := os.ReadFile(document)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range link.FindAllStringSubmatch(string(data), -1) {
			target := m[1]
			if strings.Contains(target, ":") || strings.HasPrefix(target, "#") {
				continue
			}
			path := filepath.Join(filepath.Dir(document), strings.SplitN(target, "#", 2)[0])
			if rel, err := filepath.Rel(root, path); err != nil || !filepath.IsLocal(rel) {
				t.Errorf("%s links outside the project: %s", document, target)
			} else if _, err := os.Stat(path); err != nil {
				t.Errorf("%s has a broken link: %s", document, target)
			}
		}
	}
}
