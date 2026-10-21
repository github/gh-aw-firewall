package main

import (
	"bytes"
	"cmp"
	"encoding/json/jsontext"
	"errors"
	"fmt"
	"io"
	"maps"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"
)

const (
	windowHeadroomTokens = 16_000
	charactersPerToken   = 4
)

// estimateContext approximates a conversation's tokens from its text and its
// compact tool-call JSON, at four characters per token, rounding up. It is not a
// tokenizer or a safe upper bound.
func estimateContext(conversation []Message) (characters, tokens int) {
	for _, m := range conversation {
		for _, p := range m.Parts {
			switch {
			case p.Text != nil:
				characters += utf8.RuneCountInString(*p.Text)
			case p.ToolCall != nil:
				characters += utf8.RuneCountInString(*p.ToolCall.Name) + inputLength(p.ToolCall.Input)
			case p.ToolResult != nil && p.ToolResult.Text != nil:
				characters += utf8.RuneCountInString(*p.ToolResult.Text)
			}
		}
	}
	return characters, (characters + charactersPerToken - 1) / charactersPerToken
}

// inputLength is the length in characters of the tool input re-encoded as compact
// JSON, spelling numbers as Python does after parsing. An omitted or null input
// counts as zero.
func inputLength(v jsontext.Value) int {
	data, err := lastValueWins(v)
	if err != nil {
		return utf8.RuneCount(v)
	}
	dec := jsontext.NewDecoder(bytes.NewReader(data))
	var out bytes.Buffer
	enc := jsontext.NewEncoder(&out)
	adjust := 0
	for {
		token, err := dec.ReadToken()
		if err == io.EOF {
			break
		}
		if err != nil {
			return utf8.RuneCount(v)
		}
		switch token.Kind() {
		case 'n':
			if dec.StackDepth() == 0 {
				return 0
			}
		case '0':
			raw := token.String()
			adjust += len(pythonNumber(raw)) - len(raw)
		}
		if err := enc.WriteToken(token); err != nil {
			return utf8.RuneCount(v)
		}
	}
	return utf8.RuneCount(bytes.TrimSuffix(out.Bytes(), []byte("\n"))) + adjust
}

// pythonNumber spells a JSON number as Python's json.dumps does after parsing it:
// integers exactly, floats as their shortest repr and overflowing floats as
// Infinity.
func pythonNumber(raw string) string {
	if !strings.ContainsAny(raw, ".eE") {
		if raw == "-0" {
			return "0"
		}
		return raw
	}
	f, _ := strconv.ParseFloat(raw, 64)
	switch abs := math.Abs(f); {
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case abs != 0 && (abs < 1e-4 || abs >= 1e16):
		return strconv.FormatFloat(f, 'e', -1, 64)
	}
	s := strconv.FormatFloat(f, 'f', -1, 64)
	if !strings.Contains(s, ".") {
		s += ".0"
	}
	return s
}

// Route filters the offered candidates to the pairs this table ranks that have
// enough context, ranks them by the label cell and moves an eligible current
// choice to the front. Labels come from the classification, or from heuristics
// over the last authored user message.
func (t *Table) Route(req *RouteRequest) (*RouteResponse, error) {
	if *req.Objective != t.Profile {
		return nil, requestError(BadRequest, "routing profile is not supported by this table: %s", req.Objective.Key())
	}
	authored := authoredMessages(req.Conversation)
	if len(authored) == 0 {
		return nil, requestError(BadRequest, "conversation must contain an authored user message")
	}
	var labels Labels
	if req.Classification != nil {
		labels = req.Classification.Labels
	} else {
		labels = InferLabels(authored[len(authored)-1].Text())
	}
	order := t.positions[labels.Key()]
	_, tokens := estimateContext(req.Conversation)
	minimum := uint64(tokens) + windowHeadroomTokens

	var eligible []ModelCandidate
	for _, c := range req.Models {
		if _, ranked := order[c.Pair()]; !ranked {
			continue
		}
		if c.ContextWindow == nil || uint64(*c.ContextWindow) >= minimum {
			eligible = append(eligible, c)
		}
	}
	if len(eligible) == 0 {
		return nil, requestError(NoRoute, "no eligible offered model-effort pair")
	}
	slices.SortStableFunc(eligible, func(a, b ModelCandidate) int {
		return cmp.Compare(order[a.Pair()], order[b.Pair()])
	})
	if req.CurrentID != nil {
		if i := slices.IndexFunc(eligible, func(c ModelCandidate) bool { return c.ID == *req.CurrentID }); i > 0 {
			current := eligible[i]
			copy(eligible[1:i+1], eligible[:i])
			eligible[0] = current
		}
	}
	ranked := make([]ModelChoice, len(eligible))
	for i, c := range eligible {
		ranked[i] = c.Choice()
	}
	return &RouteResponse{RankedChoices: ranked}, nil
}

// Service serves one routing profile per table. Every table shares the
// repository, model catalogue and classifier order of the first.
type Service struct {
	tables  map[Profile]*Table
	primary *Table
}

// LoadService loads every *.json table in a directory, or the single table
// file at path.
func LoadService(path string) (*Service, error) {
	paths := []string{path}
	if info, err := os.Stat(path); err != nil {
		return nil, err
	} else if info.IsDir() {
		// ReadDir rather than Glob, so a directory name holding [, * or ? still works.
		entries, err := os.ReadDir(path)
		if err != nil {
			return nil, err
		}
		paths = nil
		for _, e := range entries {
			if strings.HasSuffix(e.Name(), ".json") {
				paths = append(paths, filepath.Join(path, e.Name()))
			}
		}
		if len(paths) == 0 {
			return nil, fmt.Errorf("routing table directory holds no tables: %s", path)
		}
	}
	tables := make([]*Table, len(paths))
	for i, p := range paths {
		t, err := LoadTable(p)
		if err != nil {
			return nil, err
		}
		tables[i] = t
	}
	return NewService(tables)
}

// NewService indexes tables by profile, rejecting a profile served twice and
// tables that disagree outside their rankings.
func NewService(tables []*Table) (*Service, error) {
	if len(tables) == 0 {
		return nil, errors.New("a service requires at least one routing table")
	}
	s := &Service{tables: map[Profile]*Table{}, primary: tables[0]}
	for _, t := range tables {
		if _, ok := s.tables[t.Profile]; ok {
			return nil, fmt.Errorf("more than one routing table declares %s", t.Profile.Key())
		}
		if t.Repository != s.primary.Repository || !sameCatalogue(t.Pairs, s.primary.Pairs) ||
			!slices.Equal(t.Classification, s.primary.Classification) {
			return nil, errors.New("routing profiles must share one repository, model catalogue, and classifier order")
		}
		s.tables[t.Profile] = t
	}
	return s, nil
}

func sameCatalogue(a, b []Pair) bool {
	sorted := func(p []Pair) []Pair {
		return slices.SortedFunc(slices.Values(p), func(x, y Pair) int { return cmp.Compare(x.String(), y.String()) })
	}
	return slices.Equal(sorted(a), sorted(b))
}

// Capabilities describes the served profiles and the model catalogue.
func (s *Service) Capabilities() Capabilities {
	profiles := []Profile{}
	for _, p := range Profiles {
		if s.tables[p] != nil {
			profiles = append(profiles, p)
		}
	}
	efforts := map[string][]Effort{}
	for _, p := range s.primary.Pairs {
		if _, ok := efforts[p.Model]; !ok {
			efforts[p.Model] = []Effort{}
		}
		if p.Effort != "" {
			efforts[p.Model] = append(efforts[p.Model], p.Effort)
		}
	}
	models := []ExecutionModel{}
	for _, model := range slices.Sorted(maps.Keys(efforts)) {
		e := efforts[model]
		slices.SortFunc(e, func(a, b Effort) int {
			return cmp.Compare(slices.Index(Efforts, a), slices.Index(Efforts, b))
		})
		models = append(models, ExecutionModel{Model: model, Efforts: e})
	}
	return Capabilities{
		Name:               "gh-aw-router",
		Version:            version,
		RoutingProfiles:    profiles,
		ExecutionCatalogue: ExecutionCatalogue{Models: models},
	}
}

// Classify plans a classifier call over the shared classifier order.
func (s *Service) Classify(req *ClassifyRequest) (*ClassifyResponse, error) {
	return ClassificationPlan(req, s.primary.Classification)
}

// Route resolves automatic mode and ranks the offered models with the profile's
// table.
func (s *Service) Route(req *RouteRequest) (*RouteResponse, error) {
	profile := resolvedProfile(req)
	t := s.tables[profile]
	if t == nil {
		return nil, requestError(BadRequest, "routing profile is not served: %s", profile.Key())
	}
	resolved := *req
	resolved.Objective = &profile
	return t.Route(&resolved)
}

// resolvedProfile returns the profile a route request is served with. Automatic
// mode uses the classification's mode, or balanced when there is no
// classification or its mode is unknown.
func resolvedProfile(req *RouteRequest) Profile {
	profile := *req.Objective
	if profile.Mode == ModeAuto {
		profile.Mode = ModeBalanced
		if c := req.Classification; c != nil && c.Mode != RecommendUnknown {
			profile.Mode = Mode(c.Mode)
		}
	}
	return profile
}

// cataloguePair returns the loaded catalogue's entry for p.
func (s *Service) cataloguePair(p Pair) (Pair, bool) {
	if i := slices.Index(s.primary.Pairs, p); i >= 0 {
		return s.primary.Pairs[i], true
	}
	return Pair{}, false
}
