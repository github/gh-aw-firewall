package main

import (
	"encoding/json/v2"
	"os"
	"path/filepath"
	"testing"
)

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
	for _, c := range doc.Cases {
		t.Run(c.ID, func(t *testing.T) {
			wantType, wantScope := c.Expect.TaskType, c.Expect.Scope
			got := InferLabels(c.Text)
			if string(got.TaskType) != wantType || string(got.Scope) != wantScope {
				t.Errorf("InferLabels(%q) = %s/%s, want %s/%s", c.Text, got.TaskType, got.Scope, wantType, wantScope)
			}
		})
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
