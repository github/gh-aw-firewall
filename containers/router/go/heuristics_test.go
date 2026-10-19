package main

import (
	"encoding/json/v2"
	"os"
	"path/filepath"
	"testing"
)

// labelDifferences lists parity cases where Go deliberately differs from Python.
// Python 3.12 follows Unicode 15, so letters added later are not word characters
// there, and it applies full case folding (ﬁ to fi, ſ to s, ß to ss) where Go lowercases.
var labelDifferences = map[string]struct{ taskType, scope string }{
	"unassigned-after-lead-10D40": {"unknown", "unknown"},
	"unassigned-after-lead-10D50": {"unknown", "unknown"},
	"unassigned-after-lead-16100": {"unknown", "unknown"},
	"unassigned-after-lead-1CCF0": {"unknown", "unknown"},
	"unassigned-after-lead-1E5D0": {"unknown", "unknown"},
	"unassigned-after-lead-A7CB":  {"unknown", "unknown"},
	"unassigned-before-cue-10D40": {"unknown", "unknown"},
	"unassigned-before-cue-10D50": {"unknown", "unknown"},
	"unassigned-before-cue-16100": {"unknown", "unknown"},
	"unassigned-before-cue-1CCF0": {"unknown", "unknown"},
	"unassigned-before-cue-1E5D0": {"unknown", "unknown"},
	"unassigned-before-cue-A7CB":  {"unknown", "unknown"},
	"casefold-ligature":           {"unknown", "unknown"},
	"casefold-long-s":             {"unknown", "unknown"},
	"casefold-sharp-s":            {"unknown", "unknown"},
	"casefold-dotted-i":           {"implement", "unknown"},
}

func TestLabelsParity(t *testing.T) {
	data, err := os.ReadFile(filepath.Join(routerDir, "tests", "fixtures", "parity", "labels.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Cases []struct {
			ID     string `json:"id"`
			Text   string `json:"text"`
			Expect struct {
				TaskType string `json:"task_type"`
				Scope    string `json:"scope"`
			} `json:"expect"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Cases) == 0 {
		t.Fatal("no cases")
	}
	used := map[string]bool{}
	for _, c := range doc.Cases {
		t.Run(c.ID, func(t *testing.T) {
			wantType, wantScope := c.Expect.TaskType, c.Expect.Scope
			if diff, ok := labelDifferences[c.ID]; ok {
				used[c.ID] = true
				wantType, wantScope = diff.taskType, diff.scope
			}
			got := InferLabels(c.Text)
			if string(got.TaskType) != wantType || string(got.Scope) != wantScope {
				t.Errorf("InferLabels(%q) = %s/%s, want %s/%s", c.Text, got.TaskType, got.Scope, wantType, wantScope)
			}
		})
	}
	for id := range labelDifferences {
		if !used[id] {
			t.Errorf("known difference %q matches no case", id)
		}
	}
}

func TestInferLabels(t *testing.T) {
	cases := []struct {
		text     string
		taskType TaskType
		scope    TaskScope
	}{
		{"Diagnose the root cause across services", TaskFix, ScopeCrossSystem},
		{"Fix the architecture regression in this module", TaskFix, ScopeSubsystem},
		{"Add an error counter to this function", TaskImplement, ScopeLocal},
		{"Could you please fix this file?", TaskFix, ScopeLocal},
		{"Explain the architecture bug", TaskExplain, ScopeSubsystem},
		{"Plan a fix across services", TaskPlan, ScopeCrossSystem},
		{"Compare both files", TaskPlan, ScopeMultiFile},
		{"Rename this function", TaskRefactor, ScopeLocal},
		{"Update the dependency in this file", TaskChore, ScopeLocal},
		{"Create a debug flag", TaskImplement, ScopeUnknown},
		{"Please execute the proposed plan", TaskImplement, ScopeUnknown},
		{"How should we approach this?", TaskPlan, ScopeUnknown},
		{"The parser is failing", TaskFix, ScopeUnknown},
		{"PLEASE\nFIX this function", TaskFix, ScopeLocal},
		{"address bookmark", TaskUnknown, ScopeUnknown},
		{"microservice", TaskUnknown, ScopeUnknown},
		{"", TaskUnknown, ScopeUnknown},
	}
	for _, c := range cases {
		got := InferLabels(c.text)
		want := Labels{TaskType: c.taskType, Scope: c.scope, TaskComplexity: ComplexityUnknown}
		if got != want {
			t.Errorf("InferLabels(%q) = %+v, want %+v", c.text, got, want)
		}
	}
}

func FuzzInferLabels(f *testing.F) {
	for _, seed := range []string{"Fix this function", "please could you explain", "", "\u00a0update deps\x1c", "what's 🙂"} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, text string) {
		l := InferLabels(text)
		if l.TaskComplexity != ComplexityUnknown || l.Key() == "" {
			t.Fatalf("unexpected labels %+v", l)
		}
	})
}
