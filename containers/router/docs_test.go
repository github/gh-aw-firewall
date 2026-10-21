package main

import (
	"bytes"
	"cmp"
	"encoding/json/v2"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// TestReadmeExamplesMatchTheService posts the README's example requests to a server
// with the bundled tables, and checks the README's classifier output and route
// response examples against the route example and the response it gets.
func TestReadmeExamplesMatchTheService(t *testing.T) {
	data, err := os.ReadFile("README.md")
	if err != nil {
		t.Fatal(err)
	}
	readme := strings.ReplaceAll(string(data), "\r\n", "\n")
	service, err := LoadService(bundledTables(t))
	if err != nil {
		t.Fatal(err)
	}
	s, _ := newTestServerFor(t, service, nil)
	byID := func(a, b ModelChoice) int { return cmp.Compare(a.ID, b.ID) }
	var paths []string
	var routed any
	request := regexp.MustCompile(`--data-binary @(\S+)\s+\\\s+http://127\.0\.0\.1:8737(/\S+)`)
	for _, m := range request.FindAllStringSubmatch(readme, -1) {
		file, path := filepath.FromSlash(m[1]), m[2]
		paths = append(paths, path)
		body, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		r := serveRequest(t, s, http.MethodPost, path, map[string]string{"Content-Type": "application/json"}, bytes.NewReader(body))
		if r.status != http.StatusOK {
			t.Fatalf("%s with %s: HTTP %d: %s", path, file, r.status, r.body)
		}
		var offered struct {
			Models []ModelChoice `json:"models"`
		}
		var ranked struct {
			RankedChoices []ModelChoice `json:"ranked_choices"`
		}
		if err := json.Unmarshal(body, &offered); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(r.body, &ranked); err != nil {
			t.Fatal(err)
		}
		slices.SortFunc(offered.Models, byID)
		slices.SortFunc(ranked.RankedChoices, byID)
		if !slices.Equal(ranked.RankedChoices, offered.Models) {
			t.Errorf("%s with %s ranks %v, want every offered choice %v", path, file, ranked.RankedChoices, offered.Models)
		}
		if path == "/route" {
			routed = r.json(t)
		}
	}
	if want := []string{"/classify", "/route"}; !slices.Equal(paths, want) {
		t.Errorf("the README's curl examples post to %v, want %v", paths, want)
	}

	var outputs, responses []any
	block := regexp.MustCompile("(?s)```json\n(.*?)\n```")
	for _, m := range block.FindAllStringSubmatch(readme, -1) {
		var example map[string]any
		if err := json.Unmarshal([]byte(m[1]), &example); err != nil {
			t.Fatalf("README JSON example: %v\n%s", err, m[1])
		}
		if _, ok := example["labels"]; ok {
			outputs = append(outputs, example)
		}
		if _, ok := example["ranked_choices"]; ok {
			responses = append(responses, example)
		}
	}
	if want := []any{exampleRequest(t, "route")["classification"]}; !reflect.DeepEqual(outputs, want) {
		t.Errorf("the README's classifier output examples are %v, want the route example's classification %v", outputs, want)
	}
	if want := []any{routed}; !reflect.DeepEqual(responses, want) {
		t.Errorf("the README's route response examples are %v, want the response %v", responses, want)
	}
}

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
