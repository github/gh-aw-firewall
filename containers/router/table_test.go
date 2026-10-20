package main

import (
	"encoding/json/v2"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// syntheticDocument returns a cost/balanced table that ranks the choices in the
// same order for every label cell, as the Python tests' synthetic table does.
func syntheticDocument(choices ...string) map[string]any {
	if len(choices) == 0 {
		choices = []string{"provider/fast", "provider/reasoning:medium"}
	}
	return map[string]any{
		"schema_version":         1,
		"profile":                map[string]any{"goal": "cost", "mode": "balanced"},
		"repository":             "global",
		"classification_choices": anys(choices),
		"rankings": []any{map[string]any{
			"applies_to": anys(allLabelKeys()),
			"choices":    anys(choices),
		}},
	}
}

func allLabelKeys() []string {
	var keys []string
	for _, task := range TaskTypes {
		for _, scope := range TaskScopes {
			for _, complexity := range TaskComplexities {
				keys = append(keys, Labels{TaskType: task, Scope: scope, TaskComplexity: complexity}.Key())
			}
		}
	}
	return keys
}

func anys[T any](values []T) []any {
	out := make([]any, len(values))
	for i, v := range values {
		out[i] = v
	}
	return out
}

func marshal(t testing.TB, v any) []byte {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func mustTable(t testing.TB, doc map[string]any) *Table {
	t.Helper()
	table, err := ParseTable(marshal(t, doc))
	if err != nil {
		t.Fatal(err)
	}
	return table
}

// Accessors for mutating a synthetic document.
func group(doc map[string]any, i int) map[string]any {
	return doc["rankings"].([]any)[i].(map[string]any)
}

func appendTo(m map[string]any, key string, v any) { m[key] = append(m[key].([]any), v) }

// newGroup moves the first group's last cell into a new group with derived choices.
func newGroup(doc map[string]any, choices func([]any) []any) {
	first := group(doc, 0)
	cells := first["applies_to"].([]any)
	first["applies_to"] = cells[:len(cells)-1]
	appendTo(doc, "rankings", map[string]any{
		"applies_to": []any{cells[len(cells)-1]},
		"choices":    choices(slices.Clone(first["choices"].([]any))),
	})
}

func TestParseTableRejections(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(map[string]any)
		want   string // a fragment of the error, or "" for any error
	}{
		// Defects the published schema also rejects.
		{"unknown top-level field", func(d map[string]any) { d["default_efforts"] = map[string]any{"provider/reasoning": "medium"} }, "default_efforts"},
		{"unknown profile field", func(d map[string]any) { d["profile"].(map[string]any)["overrides"] = nil }, "overrides"},
		{"unknown ranking group field", func(d map[string]any) { group(d, 0)["weight"] = 1 }, "weight"},
		{"missing profile", func(d map[string]any) { delete(d, "profile") }, "profile"},
		{"missing profile goal", func(d map[string]any) { delete(d["profile"].(map[string]any), "goal") }, "fixed cost or cost-speed profile"},
		{"missing repository", func(d map[string]any) { delete(d, "repository") }, "repository"},
		{"missing classification_choices", func(d map[string]any) { delete(d, "classification_choices") }, "classification_choices"},
		{"missing rankings", func(d map[string]any) { delete(d, "rankings") }, "rankings"},
		{"missing applies_to", func(d map[string]any) { delete(group(d, 0), "applies_to") }, "applies_to"},
		{"missing choices", func(d map[string]any) { delete(group(d, 0), "choices") }, "choices"},
		{"schema_version 0", func(d map[string]any) { d["schema_version"] = 0 }, "schema_version"},
		{"schema_version 2", func(d map[string]any) { d["schema_version"] = 2 }, "schema_version"},
		{"schema_version 5", func(d map[string]any) { d["schema_version"] = 5 }, "schema_version"},
		{"schema_version as a float", func(d map[string]any) { d["schema_version"] = 1.5 }, "schema_version"},
		{"schema_version as a string", func(d map[string]any) { d["schema_version"] = "1" }, "schema_version"},
		{"schema_version as a boolean", func(d map[string]any) { d["schema_version"] = true }, "schema_version"},
		{"auto profile", func(d map[string]any) { d["profile"].(map[string]any)["mode"] = "auto" }, "must declare a fixed"},
		{"unknown mode", func(d map[string]any) { d["profile"].(map[string]any)["mode"] = "custom" }, "must declare a fixed"},
		{"unknown goal", func(d map[string]any) { d["profile"].(map[string]any)["goal"] = "speed" }, "must declare a fixed"},
		{"empty repository", func(d map[string]any) { d["repository"] = "" }, "repository"},
		{"repository with leading whitespace", func(d map[string]any) { d["repository"] = " global" }, "repository must be canonical"},
		{"repository with trailing whitespace", func(d map[string]any) { d["repository"] = "global " }, "repository must be canonical"},
		{"repository with a trailing newline", func(d map[string]any) { d["repository"] = "global\n" }, "repository must be canonical"},
		{"repository with a no-break space", func(d map[string]any) { d["repository"] = "\u00a0global" }, "repository must be canonical"},
		{"repository not a string", func(d map[string]any) { d["repository"] = 1 }, "repository"},
		{"unknown label key", func(d map[string]any) { appendTo(group(d, 0), "applies_to", "invalid/local/easy") }, "unknown label cell"},
		{"label key in another order", func(d map[string]any) { appendTo(group(d, 0), "applies_to", "local/fix/easy") }, "unknown label cell"},
		{"label key with a trailing newline", func(d map[string]any) { appendTo(group(d, 0), "applies_to", "fix/local/easy\n") }, "unknown label cell"},
		{"cell repeated in one group", func(d map[string]any) { appendTo(group(d, 0), "applies_to", "fix/local/easy") }, "assigned to cost/balanced more than once"},
		{"choice repeated in one group", func(d map[string]any) { appendTo(group(d, 0), "choices", "provider/fast") }, "full ordered pair list"},
		{"unknown effort", func(d map[string]any) { group(d, 0)["choices"].([]any)[1] = "provider/reasoning:turbo" }, "unknown reasoning effort"},
		{"non-canonical identity", func(d map[string]any) { group(d, 0)["choices"].([]any)[0] = " provider/fast" }, "canonical"},
		{"empty rankings", func(d map[string]any) { d["rankings"] = []any{} }, "rankings"},
		{"empty applies_to", func(d map[string]any) { group(d, 0)["applies_to"] = []any{} }, "must not be empty"},
		{"empty choices", func(d map[string]any) { group(d, 0)["choices"] = []any{} }, "must not be empty"},
		{"empty classification_choices", func(d map[string]any) { d["classification_choices"] = []any{} }, "classification_choices"},
		{"null classification_choices", func(d map[string]any) { d["classification_choices"] = nil }, "classification_choices"},
		{"rankings not an array", func(d map[string]any) { d["rankings"] = map[string]any{} }, "rankings"},
		{"applies_to not an array", func(d map[string]any) { group(d, 0)["applies_to"] = "fix/local/easy" }, "applies_to"},

		// Cross-reference rules only the loader enforces.
		{"missing label cell", func(d map[string]any) {
			g := group(d, 0)
			cells := g["applies_to"].([]any)
			g["applies_to"] = cells[:len(cells)-1]
		}, "every label combination"},
		{"cell assigned to two groups", func(d map[string]any) {
			g := group(d, 0)
			appendTo(d, "rankings", map[string]any{"applies_to": []any{g["applies_to"].([]any)[0]}, "choices": []any{"provider/reasoning:medium", "provider/fast"}})
		}, "more than once"},
		{"ranking not a permutation", func(d map[string]any) { newGroup(d, func(c []any) []any { return c[:1] }) }, "full ordered pair list"},
		{"ranking with an unknown model", func(d map[string]any) {
			newGroup(d, func([]any) []any { return []any{"provider/fast", "provider/unknown"} })
		}, "full ordered pair list"},
		{"ranking with an extra model", func(d map[string]any) {
			newGroup(d, func(c []any) []any { return append(c, "provider/extra") })
		}, "full ordered pair list"},
		{"classification order not a permutation", func(d map[string]any) { d["classification_choices"] = []any{"provider/fast"} }, "full ordered pair list"},
		{"classification order repeats a pair", func(d map[string]any) { d["classification_choices"] = []any{"provider/fast", "provider/fast"} }, "full ordered pair list"},
		{"identical groups", func(d map[string]any) { newGroup(d, func(c []any) []any { return c }) }, "identical rankings must share one group"},
		{"bare alias next to explicit efforts", func(d map[string]any) { appendTo(group(d, 0), "choices", "provider/reasoning") }, "bare default aliases"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			doc := syntheticDocument()
			c.mutate(doc)
			_, err := ParseTable(marshal(t, doc))
			if err == nil {
				t.Fatal("table was accepted")
			}
			if !strings.Contains(err.Error(), c.want) {
				t.Errorf("error %q does not mention %q", err, c.want)
			}
		})
	}
}

func TestParseTableAcceptsOmittedSchemaVersion(t *testing.T) {
	doc := syntheticDocument()
	delete(doc, "schema_version")
	mustTable(t, doc)
}

func TestParseTableRepeatedKeys(t *testing.T) {
	valid := marshal(t, syntheticDocument())
	earlier := append([]byte(`{"schema_version":2,`), valid[1:]...)
	if _, err := ParseTable(earlier); err != nil {
		t.Errorf("an earlier repeated schema_version was not replaced: %v", err)
	}
	partial := append(slices.Clone(valid[:len(valid)-1]), `,"profile":{"goal":"cost"}}`...)
	if _, err := ParseTable(partial); err == nil {
		t.Error("a repeated partial profile was merged into the earlier one")
	}
}

func TestParseTableRejectsNonTables(t *testing.T) {
	valid := marshal(t, syntheticDocument())
	for name, data := range map[string][]byte{
		"not JSON":      []byte("routing"),
		"empty":         nil,
		"array":         []byte("[]"),
		"byte order":    append([]byte("\ufeff"), valid...),
		"trailing data": append(slices.Clone(valid), "{}"...),
	} {
		if _, err := ParseTable(data); err == nil {
			t.Errorf("%s: table was accepted", name)
		}
	}
}

func TestTableModelIdentities(t *testing.T) {
	cases := map[string]bool{
		"provider/model": true, "provider/my model": true, "provider /model": true, "p/m": true,
		"provider": false, "provider/": false, "/model": false, "a/b/c": false,
		" provider/model": false, "provider/model ": false, "\u00a0provider/model": false,
		"provider/model :medium": false, "provider/model:": false, "provider/model:turbo": false,
		"provider/model:MEDIUM": false, "provider/model:medium:high": false,
		"provider/model\n": false, "provider/model:medium\n": false,
		// Python's str.isspace, like Go, does not count these as whitespace.
		"\ufeffprovider/model": true, "provider/model\u200b": true, "\u180eprovider/model": true,
	}
	for _, effort := range Efforts {
		cases["provider/model:"+string(effort)] = true
	}
	for identity, valid := range cases {
		doc := syntheticDocument(identity)
		_, err := ParseTable(marshal(t, doc))
		if (err == nil) != valid {
			t.Errorf("%q: valid = %v, error %v", identity, valid, err)
		}
	}
}

func TestParsePair(t *testing.T) {
	for value, want := range map[string]Pair{
		"provider/model":        {Model: "provider/model"},
		"provider/model:medium": {Model: "provider/model", Effort: EffortMedium},
	} {
		got, err := ParsePair(value)
		if err != nil || got != want {
			t.Errorf("ParsePair(%q) = %v, %v", value, got, err)
		}
	}
	for _, value := range []string{"provider", " provider/model", "provider/model ", "provider/model:medium:high"} {
		if _, err := ParsePair(value); err == nil {
			t.Errorf("ParsePair(%q) accepted", value)
		}
	}
}

func TestLoadService(t *testing.T) {
	write := func(t *testing.T, path string, doc map[string]any) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, marshal(t, doc), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	withMode := func(mode string) map[string]any {
		doc := syntheticDocument()
		doc["profile"] = map[string]any{"goal": "cost", "mode": mode}
		return doc
	}

	t.Run("file", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "table.json")
		write(t, path, syntheticDocument())
		s, err := LoadService(path)
		if err != nil {
			t.Fatal(err)
		}
		if got := s.Capabilities().RoutingProfiles; len(got) != 1 || got[0].Key() != "cost/balanced" {
			t.Errorf("profiles = %v", got)
		}
	})
	t.Run("directory ignores other files and nested directories", func(t *testing.T) {
		// Glob metacharacters in the directory name must not change which files load.
		dir := filepath.Join(t.TempDir(), "tables [x]")
		write(t, filepath.Join(dir, "b.json"), withMode("balanced"))
		write(t, filepath.Join(dir, "a.json"), withMode("economy"))
		write(t, filepath.Join(dir, "nested", "c.json"), withMode("robust"))
		if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("not a table"), 0o644); err != nil {
			t.Fatal(err)
		}
		s, err := LoadService(dir)
		if err != nil {
			t.Fatal(err)
		}
		if s.primary.Profile.Key() != "cost/economy" || len(s.tables) != 2 {
			t.Errorf("primary %s, %d tables", s.primary.Profile.Key(), len(s.tables))
		}
	})
	t.Run("empty directory", func(t *testing.T) {
		if _, err := LoadService(t.TempDir()); err == nil || !strings.Contains(err.Error(), "holds no tables") {
			t.Errorf("err = %v", err)
		}
	})
	t.Run("missing path", func(t *testing.T) {
		if _, err := LoadService(filepath.Join(t.TempDir(), "absent.json")); err == nil {
			t.Error("missing path was accepted")
		}
	})
	t.Run("invalid table names its file", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "broken.json"), []byte("{}"), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadService(dir); err == nil || !strings.Contains(err.Error(), "broken.json") {
			t.Errorf("err = %v", err)
		}
	})
	t.Run("duplicate profile", func(t *testing.T) {
		dir := t.TempDir()
		write(t, filepath.Join(dir, "a.json"), syntheticDocument())
		write(t, filepath.Join(dir, "b.json"), syntheticDocument())
		if _, err := LoadService(dir); err == nil || !strings.Contains(err.Error(), "more than one routing table declares cost/balanced") {
			t.Errorf("err = %v", err)
		}
	})
}

func TestBundledTables(t *testing.T) {
	s, err := LoadService("routing")
	if err != nil {
		t.Fatal(err)
	}
	if got := s.Capabilities().RoutingProfiles; !slices.Equal(got, Profiles) {
		t.Errorf("profiles = %v", got)
	}
	if s.primary.Repository != "global" || s.primary.LabelCells() != 210 {
		t.Errorf("repository %q, %d cells", s.primary.Repository, s.primary.LabelCells())
	}
}

func FuzzParseTable(f *testing.F) {
	f.Add(marshal(f, syntheticDocument()))
	f.Add([]byte(`{"schema_version":1}`))
	f.Add([]byte(`{"rankings":[{"applies_to":["fix/local/easy"],"choices":["p/m:high","p/m"]}]}`))
	f.Fuzz(func(t *testing.T, data []byte) {
		ParseTable(data)
	})
}
