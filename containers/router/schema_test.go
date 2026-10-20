package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json/v2"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// publishedSchemas pins every published routing-table schema. A published schema never
// changes: a format change adds a new file and pins its hash here.
var publishedSchemas = map[string]string{
	"routing-table.v1.schema.json": "c76de15239db5d6ee9bfc3fa4f4b797887efe04f40334e2ca9e8afe5377461cd",
}

func TestPublishedSchemasAreFrozen(t *testing.T) {
	entries, err := os.ReadDir("schemas")
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	if want := slices.Sorted(maps.Keys(publishedSchemas)); !slices.Equal(names, want) {
		t.Fatalf("schemas/ holds %v, want %v", names, want)
	}
	for name, digest := range publishedSchemas {
		data, err := os.ReadFile(filepath.Join("schemas", name))
		if err != nil {
			t.Fatal(err)
		}
		if sum := sha256.Sum256(data); hex.EncodeToString(sum[:]) != digest {
			t.Errorf("%s is published and must not change; add a new schema version instead", name)
		}
	}
}

// TestSchemaMatchesRuntime checks the schema's enums and patterns against the Go types, and
// the patterns against every bundled and contract table.
func TestSchemaMatchesRuntime(t *testing.T) {
	var schema struct {
		ID         string `json:"$id"`
		Title      string `json:"title"`
		Properties struct {
			SchemaVersion struct {
				Const int `json:"const"`
			} `json:"schema_version"`
			Profile struct {
				Properties struct {
					Goal struct {
						Enum []Goal `json:"enum"`
					} `json:"goal"`
					Mode struct {
						Enum []Mode `json:"enum"`
					} `json:"mode"`
				} `json:"properties"`
			} `json:"profile"`
		} `json:"properties"`
		Defs map[string]struct {
			Pattern string `json:"pattern"`
		} `json:"$defs"`
	}
	data, err := os.ReadFile(filepath.Join("schemas", "routing-table.v1.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &schema); err != nil {
		t.Fatal(err)
	}
	if schema.Properties.SchemaVersion.Const != 1 || !strings.HasSuffix(schema.ID, "/routing-table.v1.schema.json") ||
		!strings.HasSuffix(schema.Title, "schema version 1") {
		t.Errorf("schema version metadata: const %d, $id %q, title %q", schema.Properties.SchemaVersion.Const, schema.ID, schema.Title)
	}

	var profiles []Profile
	for _, goal := range schema.Properties.Profile.Properties.Goal.Enum {
		for _, mode := range schema.Properties.Profile.Properties.Mode.Enum {
			profiles = append(profiles, Profile{Goal: goal, Mode: mode})
		}
	}
	if !slices.Equal(profiles, Profiles) {
		t.Errorf("schema profiles %v, want %v", profiles, Profiles)
	}

	labelPattern := schema.Defs["labelKey"].Pattern
	if want := "^" + alternation(TaskTypes) + "/" + alternation(TaskScopes) + "/" + alternation(TaskComplexities) + "$"; labelPattern != want {
		t.Errorf("labelKey pattern %q, want %q", labelPattern, want)
	}
	identityPattern := schema.Defs["modelIdentity"].Pattern
	if want := "(:" + alternation(Efforts) + ")?$"; !strings.HasSuffix(identityPattern, want) {
		t.Errorf("modelIdentity pattern %q doesn't end with %q", identityPattern, want)
	}

	labelKey, identity := regexp.MustCompile(labelPattern), regexp.MustCompile(identityPattern)
	for _, key := range allLabelKeys() {
		if !labelKey.MatchString(key) {
			t.Errorf("labelKey pattern rejects %q", key)
		}
	}
	// Keyed by source, because the bundled and contract tables share base names.
	docs := map[string]map[string]any{}
	for name, doc := range contractDocuments() {
		docs["contract "+name] = doc
	}
	bundled, _ := filepath.Glob(filepath.Join("routing", "cost-*.json"))
	if len(bundled) == 0 {
		t.Fatal("no bundled tables in routing/")
	}
	for _, path := range bundled {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var doc map[string]any
		if err := json.Unmarshal(data, &doc); err != nil {
			t.Fatal(err)
		}
		docs[filepath.ToSlash(path)] = doc
	}
	if want := len(Profiles) + len(bundled); len(docs) != want {
		t.Fatalf("checking %d tables, want %d", len(docs), want)
	}
	for name, doc := range docs {
		choices := doc["classification_choices"].([]any)
		for _, group := range doc["rankings"].([]any) {
			choices = append(choices, group.(map[string]any)["choices"].([]any)...)
		}
		for _, choice := range choices {
			if !identity.MatchString(choice.(string)) {
				t.Errorf("%s: modelIdentity pattern rejects %q", name, choice)
			}
		}
	}
}

func alternation[T ~string](values []T) string {
	var parts []string
	for _, v := range values {
		parts = append(parts, string(v))
	}
	return "(" + strings.Join(parts, "|") + ")"
}
