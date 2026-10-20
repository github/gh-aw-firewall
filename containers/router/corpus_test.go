package main

import (
	"bytes"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"maps"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// contractChoices and contractDocuments build the synthetic tables the
// routing-contract corpus was recorded against.
var contractChoices = []string{"github-copilot/router-fast", "github-copilot/router-reasoning:medium"}

func contractDocuments() map[string]map[string]any {
	docs := map[string]map[string]any{}
	for _, p := range Profiles {
		doc := syntheticDocument(contractChoices...)
		doc["profile"] = map[string]any{"goal": string(p.Goal), "mode": string(p.Mode)}
		reversed := []any{contractChoices[1], contractChoices[0]}
		var normal, reasoning []any
		for _, task := range TaskTypes {
			for _, scope := range TaskScopes {
				for _, complexity := range TaskComplexities {
					first := p.Mode == ModeRobust || p.Mode == ModeBalanced && task == TaskFix
					if p.Goal == GoalCostSpeed {
						first = !first
					}
					key := Labels{TaskType: task, Scope: scope, TaskComplexity: complexity}.Key()
					if first {
						reasoning = append(reasoning, key)
					} else {
						normal = append(normal, key)
					}
				}
			}
		}
		var rankings []any
		for _, g := range []struct{ cells, choices []any }{{normal, anys(contractChoices)}, {reasoning, reversed}} {
			if len(g.cells) > 0 {
				rankings = append(rankings, map[string]any{"applies_to": g.cells, "choices": g.choices})
			}
		}
		// The group holding the first label cell comes first.
		if first := allLabelKeys()[0]; !slices.Contains(rankings[0].(map[string]any)["applies_to"].([]any), any(first)) {
			slices.Reverse(rankings)
		}
		doc["rankings"] = rankings
		docs[string(p.Goal)+"-"+string(p.Mode)+".json"] = doc
	}
	return docs
}

// corpusCase is one reviewed request and response from testdata/routing-contract.
type corpusCase struct {
	ID           string            `json:"id"`
	Method       string            `json:"method"`
	Path         string            `json:"path"`
	Profiles     []string          `json:"profiles"`
	Headers      map[string]string `json:"headers"`
	Request      jsontext.Value    `json:"request"`
	RawRequest   *string           `json:"raw_request"`
	Status       int               `json:"status"`
	Response     jsontext.Value    `json:"response"`
	ResponseFile string            `json:"response_file"`
}

// body is the request body to send: raw_request when present, otherwise request.
func (c corpusCase) body() []byte {
	if c.RawRequest != nil {
		return []byte(*c.RawRequest)
	}
	return c.Request
}

// header defaults to a JSON content type, as README.md's Test fixtures section specifies.
func (c corpusCase) header() map[string]string {
	if c.Headers != nil {
		return c.Headers
	}
	return map[string]string{"Content-Type": "application/json"}
}

func loadCorpus(t testing.TB) []corpusCase {
	t.Helper()
	dir := filepath.Join("testdata", "routing-contract")
	files, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		t.Fatal(err)
	}
	var all []corpusCase
	// Files that aren't lists of cases must be some case's response_file.
	shared := map[string]bool{}
	for _, file := range files {
		data, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		var cases []corpusCase
		if json.Unmarshal(data, &cases) != nil {
			shared[filepath.Base(file)] = true
			continue
		}
		for _, c := range cases {
			if c.ResponseFile != "" {
				if c.Response, err = os.ReadFile(filepath.Join(dir, c.ResponseFile)); err != nil {
					t.Fatal(err)
				}
			}
			all = append(all, c)
		}
	}
	for _, c := range all {
		delete(shared, c.ResponseFile)
	}
	for name := range shared {
		t.Fatalf("%s is neither a list of cases nor a case's response_file", filepath.Join(dir, name))
	}
	if len(all) == 0 {
		t.Fatal("the routing-contract corpus has no cases")
	}
	return all
}

// checkCorpusResponse compares successful responses exactly and errors by status and code.
func checkCorpusResponse(t testing.TB, c corpusCase, status int, body []byte) {
	t.Helper()
	if status != c.Status {
		t.Errorf("%s: got HTTP %d, want %d: %s", c.ID, status, c.Status, body)
		return
	}
	if status == 204 {
		if len(body) != 0 {
			t.Errorf("%s: readiness response has a body: %q", c.ID, body)
		}
		return
	}
	var got, want map[string]any
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("%s: %v: %q", c.ID, err, body)
	}
	if err := json.Unmarshal(c.Response, &want); err != nil {
		t.Fatalf("%s: fixture: %v", c.ID, err)
	}
	if status >= 400 {
		if got["code"] != want["code"] || len(got) != 2 {
			t.Errorf("%s: got %s, want code %v", c.ID, body, want["code"])
		}
		return
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("%s: response %s\nwant %s", c.ID, body, c.Response)
	}
}

// TestRoutingContractCorpusCoverage checks that case IDs are unique, that every
// served path has a case, and that the explicit-* route cases cover every profile.
func TestRoutingContractCorpusCoverage(t *testing.T) {
	ids := map[string]bool{}
	paths := map[string]bool{}
	explicit := map[Profile]bool{}
	for _, c := range loadCorpus(t) {
		if ids[c.ID] {
			t.Errorf("duplicate case ID %s", c.ID)
		}
		ids[c.ID] = true
		paths[c.Path] = true
		if strings.HasPrefix(c.ID, "explicit-") {
			var req struct {
				Objective Profile `json:"objective"`
			}
			if err := json.Unmarshal(c.Request, &req); err != nil {
				t.Fatalf("%s: %v", c.ID, err)
			}
			if !slices.Contains(Profiles, req.Objective) {
				t.Errorf("%s routes with %s, which isn't a profile", c.ID, req.Objective.Key())
			}
			explicit[req.Objective] = true
		}
	}
	for path := range servedRoutes {
		if !paths[path] {
			t.Errorf("no case requests %s", path)
		}
	}
	for _, p := range Profiles {
		if !explicit[p] {
			t.Errorf("no explicit-* case routes with the %s profile", p.Key())
		}
	}
}

// TestRoutingContractCorpus replays every corpus case through the HTTP handler.
func TestRoutingContractCorpus(t *testing.T) {
	docs := contractDocuments()
	for _, c := range loadCorpus(t) {
		t.Run(c.ID, func(t *testing.T) {
			names := c.Profiles
			if names == nil {
				names = slices.Collect(maps.Keys(docs))
			}
			var served []*Table
			for _, name := range slices.Sorted(slices.Values(names)) {
				served = append(served, mustTable(t, docs[name]))
			}
			service, err := NewService(served)
			if err != nil {
				t.Fatal(err)
			}
			s, _ := newTestServerFor(t, service, nil)
			r := serveRequest(t, s, c.Method, c.Path, c.header(), bytes.NewReader(c.body()))
			checkCorpusResponse(t, c, r.status, r.body)
		})
	}
}
