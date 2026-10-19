package main

import (
	"encoding/json/jsontext"
	"encoding/json/v2"
	"errors"
	"fmt"
	"os"
	"slices"
	"strings"
)

// Table is one validated routing table: a fixed profile's ranking of the model
// catalogue for every label cell, plus the classifier preference order.
type Table struct {
	Profile    Profile
	Repository string
	// Pairs is the model catalogue, in the order of the first ranking.
	Pairs []Pair
	// Classification is the classifier preference order.
	Classification []Pair
	// positions maps a label cell key to each pair's rank in that cell.
	positions map[string]map[Pair]int
}

type tableDocument struct {
	SchemaVersion         schemaVersion   `json:"schema_version"`
	Profile               *Profile        `json:"profile"`
	Repository            string          `json:"repository"`
	ClassificationChoices List[string]    `json:"classification_choices"`
	Rankings              List[rankGroup] `json:"rankings"`
}

type rankGroup struct {
	AppliesTo List[string] `json:"applies_to"`
	Choices   List[string] `json:"choices"`
}

// schemaVersion accepts only the JSON integer 1. An omitted version means 1.
type schemaVersion struct{}

func (schemaVersion) UnmarshalJSONFrom(dec *jsontext.Decoder) error {
	tok, err := dec.ReadToken()
	if err != nil {
		return err
	}
	if tok.Kind() != '0' || tok.String() != "1" {
		return errors.New("schema_version must be 1")
	}
	return nil
}

// LoadTable reads and validates the routing table at path.
func LoadTable(path string) (*Table, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	t, err := ParseTable(data)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return t, nil
}

// ParseTable validates a routing table: its schema, a fixed profile, canonical
// model identities, full label coverage and rankings that permute one catalogue.
func ParseTable(data []byte) (*Table, error) {
	var doc tableDocument
	err := json.Unmarshal(data, &doc, json.RejectUnknownMembers(true), jsontext.AllowDuplicateNames(true))
	if err != nil {
		return nil, errors.New(strings.TrimPrefix(err.Error(), "json: "))
	}
	switch {
	case doc.Profile == nil:
		return nil, errors.New("profile: field required")
	case !slices.Contains(Profiles, *doc.Profile):
		return nil, errors.New("routing table must declare a fixed cost or cost-speed profile")
	case doc.Repository == "":
		return nil, errors.New("repository: must not be empty")
	case doc.Repository != trimSpace(doc.Repository):
		return nil, errors.New("routing table repository must be canonical")
	case len(doc.ClassificationChoices) == 0:
		return nil, errors.New("classification_choices: must not be empty")
	case len(doc.Rankings) == 0:
		return nil, errors.New("rankings: must not be empty")
	}
	for i, group := range doc.Rankings {
		if len(group.AppliesTo) == 0 || len(group.Choices) == 0 {
			return nil, fmt.Errorf("rankings[%d]: applies_to and choices must not be empty", i)
		}
	}

	t := &Table{
		Profile:    *doc.Profile,
		Repository: doc.Repository,
		positions:  make(map[string]map[Pair]int),
	}
	explicit := map[string]bool{}
	for _, value := range doc.Rankings[0].Choices {
		pair, err := ParsePair(value)
		if err != nil {
			return nil, err
		}
		t.Pairs = append(t.Pairs, pair)
		if pair.Effort != "" {
			explicit[pair.Model] = true
		}
	}
	for _, pair := range t.Pairs {
		if pair.Effort == "" && explicit[pair.Model] {
			return nil, errors.New("models with efforts must not include bare default aliases")
		}
	}

	cells := labelCells()
	var seen [][]string
	for _, group := range doc.Rankings {
		if slices.ContainsFunc(seen, func(s []string) bool { return slices.Equal(s, group.Choices) }) {
			return nil, errors.New("identical rankings must share one group")
		}
		seen = append(seen, group.Choices)
		_, order, err := t.compileOrder(group.Choices)
		if err != nil {
			return nil, err
		}
		for _, key := range group.AppliesTo {
			if !cells[key] {
				return nil, fmt.Errorf("applies_to names an unknown label cell: %q", key)
			}
			if _, ok := t.positions[key]; ok {
				return nil, fmt.Errorf("label cell is assigned to %s more than once: %q", t.Profile.Key(), key)
			}
			t.positions[key] = order
		}
	}
	if len(t.positions) != len(cells) {
		return nil, errors.New("routing table must contain every label combination")
	}
	if t.Classification, _, err = t.compileOrder(doc.ClassificationChoices); err != nil {
		return nil, err
	}
	return t, nil
}

// LabelCells returns the number of label cells the table ranks.
func (t *Table) LabelCells() int { return len(t.positions) }

// compileOrder parses a ranking that must be a permutation of the catalogue.
func (t *Table) compileOrder(choices []string) ([]Pair, map[Pair]int, error) {
	ranking := make([]Pair, len(choices))
	order := make(map[Pair]int, len(choices))
	for i, value := range choices {
		pair, err := ParsePair(value)
		if err != nil {
			return nil, nil, err
		}
		ranking[i] = pair
		order[pair] = i
	}
	if len(order) != len(ranking) || len(order) != len(t.Pairs) ||
		slices.ContainsFunc(t.Pairs, func(p Pair) bool { _, ok := order[p]; return !ok }) {
		return nil, nil, errors.New("every ranking must contain the full ordered pair list")
	}
	return ranking, order, nil
}

// ParsePair decodes a canonical table identity: provider/model, optionally
// followed by :effort.
func ParsePair(value string) (Pair, error) {
	pair := Pair{Model: value}
	if i := strings.LastIndexByte(value, ':'); i >= 0 {
		pair = Pair{Model: value[:i], Effort: Effort(value[i+1:])}
		if !slices.Contains(Efforts, pair.Effort) {
			return Pair{}, fmt.Errorf("unknown reasoning effort in model-effort string: %q", value)
		}
	}
	if !ValidModelID(pair.Model) {
		return Pair{}, fmt.Errorf("model must be provider/model: %q", value)
	}
	if pair.Model != trimSpace(pair.Model) || strings.Contains(pair.Model, ":") {
		return Pair{}, fmt.Errorf("model-effort string must be canonical: %q", value)
	}
	return pair, nil
}

// labelCells returns every label cell key, including combinations with unknown values.
func labelCells() map[string]bool {
	cells := map[string]bool{}
	for _, task := range TaskTypes {
		for _, scope := range TaskScopes {
			for _, complexity := range TaskComplexities {
				cells[Labels{TaskType: task, Scope: scope, TaskComplexity: complexity}.Key()] = true
			}
		}
	}
	return cells
}
