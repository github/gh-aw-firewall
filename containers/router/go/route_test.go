package main

import (
	"encoding/json/jsontext"
	"encoding/json/v2"
	"errors"
	"maps"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func ptr[T any](v T) *T { return &v }

func userText(text string) Message {
	return Message{Role: RoleUser, Parts: List[Part]{{Text: ptr(text)}}}
}

func routeRequest(text string, currentID *string, models ...ModelCandidate) *RouteRequest {
	return &RouteRequest{
		Objective:    &Profile{GoalCost, ModeBalanced},
		CurrentID:    currentID,
		Conversation: List[Message]{userText(text)},
		Models:       models,
	}
}

func candidate(id, model string, effort Effort) ModelCandidate {
	return ModelCandidate{ID: id, Model: model, Effort: effort}
}

func window(n uint64) *ContextWindow { return ptr(ContextWindow(n)) }

// ids returns the ranked choice ids, or the error so comparisons fail with it.
func ids(resp *RouteResponse, err error) []string {
	if err != nil {
		return []string{"error: " + err.Error()}
	}
	var out []string
	for _, c := range resp.RankedChoices {
		out = append(out, c.ID)
	}
	return out
}

func wantKind(t *testing.T, err error, kind Kind, detail string) {
	t.Helper()
	if KindOf(err) != kind || !strings.Contains(err.Error(), detail) {
		t.Fatalf("got error %v, want kind %d mentioning %q", err, kind, detail)
	}
}

func TestRouteOrdersExactChoicesAndPinsCurrent(t *testing.T) {
	table := mustTable(t, syntheticDocument())
	req := routeRequest("Fix this function", ptr("explicit"),
		candidate("fast", "provider/fast", ""),
		candidate("explicit", "provider/reasoning", EffortMedium))
	resp, err := table.Route(req)
	if got := ids(resp, err); !slices.Equal(got, []string{"explicit", "fast"}) {
		t.Fatalf("ranked %v", got)
	}
	if resp.RankedChoices[0].Effort != EffortMedium || resp.RankedChoices[1].Effort != "" {
		t.Errorf("efforts %+v", resp.RankedChoices)
	}
}

func TestRouteIgnoresMissingOrUnknownEffort(t *testing.T) {
	table := mustTable(t, syntheticDocument())
	for _, effort := range []Effort{"", EffortLow} {
		req := routeRequest("Fix this function", nil,
			candidate("fast", "provider/fast", ""),
			candidate("reasoning", "provider/reasoning", effort))
		if got := ids(table.Route(req)); !slices.Equal(got, []string{"fast"}) {
			t.Errorf("effort %q: ranked %v", effort, got)
		}
		req.Models = req.Models[1:]
		_, err := table.Route(req)
		wantKind(t, err, NoRoute, "no eligible")
	}
}

func TestRouteDistinguishesExplicitNoneEffortFromOmission(t *testing.T) {
	table := mustTable(t, syntheticDocument("provider/fast", "provider/reasoning:none"))
	req := routeRequest("Fix this function", nil, candidate("reasoning", "provider/reasoning", EffortNone))
	resp, err := table.Route(req)
	if got := ids(resp, err); !slices.Equal(got, []string{"reasoning"}) || resp.RankedChoices[0].Effort != EffortNone {
		t.Errorf("ranked %+v", resp.RankedChoices)
	}
	req.Models[0].Effort = ""
	_, err = table.Route(req)
	wantKind(t, err, NoRoute, "no eligible")
}

func TestRouteFiltersSmallContextWindows(t *testing.T) {
	table := mustTable(t, syntheticDocument())
	minimum := uint64(windowHeadroomTokens + 1)
	req := routeRequest("x", nil,
		ModelCandidate{ID: "small", Model: "provider/fast", ContextWindow: window(minimum - 1)},
		ModelCandidate{ID: "large", Model: "provider/fast", ContextWindow: window(minimum)},
		ModelCandidate{ID: "huge", Model: "provider/fast", ContextWindow: window(math.MaxUint64)})
	if got := ids(table.Route(req)); !slices.Equal(got, []string{"large", "huge"}) {
		t.Errorf("ranked %v", got)
	}
	req.Models = req.Models[:1]
	_, err := table.Route(req)
	wantKind(t, err, NoRoute, "no eligible")
}

func TestRouteIgnoresUnknownModelIdentities(t *testing.T) {
	table := mustTable(t, syntheticDocument())
	unknown := candidate("unknown", "provider/unknown", "")
	fast := candidate("fast", "provider/fast", "")
	req := routeRequest("Fix this function", ptr("unknown"), unknown, fast)
	if got := ids(table.Route(req)); !slices.Equal(got, []string{"fast"}) {
		t.Errorf("ranked %v", got)
	}
	req.Models = List[ModelCandidate]{unknown}
	_, err := table.Route(req)
	wantKind(t, err, NoRoute, "no eligible")
	fast.ContextWindow = window(1)
	req.Models = List[ModelCandidate]{unknown, fast}
	_, err = table.Route(req)
	wantKind(t, err, NoRoute, "no eligible")
}

func TestIneligibleCurrentChoiceDoesNotOverrideRanking(t *testing.T) {
	table := mustTable(t, syntheticDocument())
	for _, current := range []string{"missing", "too-small"} {
		req := routeRequest("Fix this function", ptr(current),
			ModelCandidate{ID: "too-small", Model: "provider/fast", ContextWindow: window(1)},
			candidate("second", "provider/reasoning", EffortMedium),
			candidate("first", "provider/fast", ""))
		if got := ids(table.Route(req)); !slices.Equal(got, []string{"first", "second"}) {
			t.Errorf("current %q: ranked %v", current, got)
		}
	}
}

func TestEqualIdentitiesPreserveOfferedOrder(t *testing.T) {
	table := mustTable(t, syntheticDocument())
	req := routeRequest("Fix this function", ptr("third"),
		candidate("first", "provider/fast", ""),
		candidate("second", "provider/fast", ""),
		candidate("third", "provider/fast", ""))
	if got := ids(table.Route(req)); !slices.Equal(got, []string{"third", "first", "second"}) {
		t.Errorf("ranked %v", got)
	}
}

func TestRouteRequiresAuthoredUserMessage(t *testing.T) {
	table := mustTable(t, syntheticDocument())
	req := routeRequest(" \n", nil, candidate("fast", "provider/fast", ""))
	req.Conversation = append(req.Conversation, Message{Role: RoleAssistant, Parts: List[Part]{{Text: ptr("Fix this")}}})
	_, err := table.Route(req)
	wantKind(t, err, BadRequest, "authored user message")
}

func TestRouteUsesClassificationOrHeuristicLabels(t *testing.T) {
	doc := syntheticDocument()
	fix := Labels{TaskType: TaskFix, Scope: ScopeLocal, TaskComplexity: ComplexityUnknown}.Key()
	g := group(doc, 0)
	g["applies_to"] = slices.DeleteFunc(g["applies_to"].([]any), func(k any) bool { return k == fix })
	appendTo(doc, "rankings", map[string]any{"applies_to": []any{fix}, "choices": []any{"provider/reasoning:medium", "provider/fast"}})
	table := mustTable(t, doc)
	models := []ModelCandidate{candidate("fast", "provider/fast", ""), candidate("reasoning", "provider/reasoning", EffortMedium)}

	req := routeRequest("Fix this function", nil, models...)
	if got := ids(table.Route(req)); !slices.Equal(got, []string{"reasoning", "fast"}) {
		t.Errorf("heuristic labels: ranked %v", got)
	}
	req.Classification = &ClassifierOutput{Labels: Labels{TaskType: TaskExplain, Scope: ScopeLocal, TaskComplexity: ComplexityUnknown}, Mode: RecommendBalanced}
	if got := ids(table.Route(req)); !slices.Equal(got, []string{"fast", "reasoning"}) {
		t.Errorf("classified labels: ranked %v", got)
	}
}

func TestTableServesOnlyItsDeclaredProfile(t *testing.T) {
	for _, mode := range []Mode{ModeEconomy, ModeBalanced, ModeRobust} {
		doc := syntheticDocument()
		doc["profile"] = map[string]any{"goal": "cost", "mode": string(mode)}
		table := mustTable(t, doc)
		req := routeRequest("Fix this function", nil, candidate("fast", "provider/fast", ""))
		req.Objective = &Profile{GoalCost, mode}
		if got := ids(table.Route(req)); !slices.Equal(got, []string{"fast"}) {
			t.Errorf("%s: ranked %v", mode, got)
		}
		req.Objective = &Profile{GoalCost, ModeBalanced}
		if mode == ModeBalanced {
			req.Objective.Mode = ModeRobust
		}
		_, err := table.Route(req)
		wantKind(t, err, BadRequest, "not supported by this table")
	}
}

func TestContextEstimate(t *testing.T) {
	conversation := []Message{{Role: RoleUser, Parts: List[Part]{
		{Text: ptr("abc")},
		{ToolCall: &ToolCall{ID: ptr("call"), Name: ptr("lookup"), Input: jsontext.Value(`{ "key" : "é" }`)}},
		{ToolCall: &ToolCall{ID: ptr("none"), Name: ptr("ping")}},
		{ToolCall: &ToolCall{ID: ptr("null"), Name: ptr("ping"), Input: jsontext.Value("null")}},
		{ToolResult: &ToolResult{ID: ptr("call"), Text: ptr("done"), OK: ptr(true)}},
		{ToolResult: &ToolResult{ID: ptr("empty")}},
	}}}
	characters, tokens := estimateContext(conversation)
	want := len("abc") + len("lookup") + len(`{"key":"é"}`) - 1 + len("ping") + len("ping") + len("done")
	if characters != want || tokens != (want+3)/4 {
		t.Errorf("estimate = %d characters, %d tokens; want %d", characters, tokens, want)
	}
}

func TestServiceCapabilities(t *testing.T) {
	doc := syntheticDocument("provider/fast", "provider/reasoning:medium", "provider/reasoning:low", "a/model:high")
	s, err := NewService([]*Table{mustTable(t, doc)})
	if err != nil {
		t.Fatal(err)
	}
	got := s.Capabilities()
	want := Capabilities{
		Name:            "gh-aw-router",
		Version:         version,
		RoutingProfiles: []Profile{{GoalCost, ModeBalanced}},
		ExecutionCatalogue: ExecutionCatalogue{Models: []ExecutionModel{
			{Model: "a/model", Efforts: []Effort{EffortHigh}},
			{Model: "provider/fast", Efforts: []Effort{}},
			{Model: "provider/reasoning", Efforts: []Effort{EffortLow, EffortMedium}},
		}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("capabilities = %+v", got)
	}
	if data := string(marshal(t, got.ExecutionCatalogue.Models[1])); data != `{"efforts":[],"model":"provider/fast"}` {
		t.Errorf("empty efforts encode as %s", data)
	}
}

// profileTables returns one synthetic table per profile. The table for target
// ranks the classifier cell's choices in reverse.
func profileTables(t *testing.T, target Profile) []*Table {
	t.Helper()
	cell := ClassificationLabels.Key()
	var tables []*Table
	for _, p := range Profiles {
		doc := syntheticDocument()
		doc["profile"] = map[string]any{"goal": string(p.Goal), "mode": string(p.Mode)}
		if p == target {
			g := group(doc, 0)
			g["applies_to"] = slices.DeleteFunc(g["applies_to"].([]any), func(k any) bool { return k == cell })
			appendTo(doc, "rankings", map[string]any{"applies_to": []any{cell}, "choices": []any{"provider/reasoning:medium", "provider/fast"}})
		}
		tables = append(tables, mustTable(t, doc))
	}
	return tables
}

func planningModels() List[ModelCandidate] {
	return List[ModelCandidate]{candidate("fast", "provider/fast", ""), candidate("reasoning", "provider/reasoning", EffortMedium)}
}

func TestServiceResolvesAutoMode(t *testing.T) {
	cases := []struct {
		requested      Mode
		recommendation Recommendation
		effective      Mode
	}{
		{ModeAuto, RecommendEconomy, ModeEconomy},
		{ModeAuto, RecommendBalanced, ModeBalanced},
		{ModeAuto, RecommendRobust, ModeRobust},
		{ModeAuto, RecommendUnknown, ModeBalanced},
		{ModeEconomy, RecommendRobust, ModeEconomy},
		{ModeBalanced, RecommendEconomy, ModeBalanced},
		{ModeRobust, RecommendBalanced, ModeRobust},
	}
	for _, goal := range []Goal{GoalCost, GoalCostSpeed} {
		for _, c := range cases {
			s, err := NewService(profileTables(t, Profile{goal, c.effective}))
			if err != nil {
				t.Fatal(err)
			}
			req := &RouteRequest{
				Objective:      &Profile{goal, c.requested},
				Classification: &ClassifierOutput{Labels: ClassificationLabels, Mode: c.recommendation},
				Conversation:   List[Message]{userText("Fix this function")},
				Models:         planningModels(),
			}
			if got := ids(s.Route(req)); !slices.Equal(got, []string{"reasoning", "fast"}) {
				t.Errorf("%s/%s with %s: ranked %v", goal, c.requested, c.recommendation, got)
			}
			if req.Objective.Mode != c.requested {
				t.Error("Route changed the request's objective")
			}
		}
	}
}

func TestServiceAutoWithoutClassificationUsesBalanced(t *testing.T) {
	s, err := NewService([]*Table{mustTable(t, syntheticDocument())})
	if err != nil {
		t.Fatal(err)
	}
	req := routeRequest("Fix this function", nil, planningModels()...)
	req.Objective.Mode = ModeAuto
	if got := ids(s.Route(req)); !slices.Equal(got, []string{"fast", "reasoning"}) {
		t.Errorf("ranked %v", got)
	}
}

func TestServiceRejectsUnservedProfiles(t *testing.T) {
	cases := []struct {
		served         Mode
		recommendation *Recommendation
		effective      Mode
	}{
		{ModeBalanced, ptr(RecommendEconomy), ModeEconomy},
		{ModeBalanced, ptr(RecommendRobust), ModeRobust},
		{ModeRobust, ptr(RecommendUnknown), ModeBalanced},
		{ModeRobust, nil, ModeBalanced},
	}
	for _, goal := range []Goal{GoalCost, GoalCostSpeed} {
		for _, c := range cases {
			doc := syntheticDocument()
			doc["profile"] = map[string]any{"goal": string(goal), "mode": string(c.served)}
			s, err := NewService([]*Table{mustTable(t, doc)})
			if err != nil {
				t.Fatal(err)
			}
			req := routeRequest("Fix this function", nil, planningModels()...)
			req.Objective = &Profile{goal, ModeAuto}
			if c.recommendation != nil {
				req.Classification = &ClassifierOutput{Labels: ClassificationLabels, Mode: *c.recommendation}
			}
			_, err = s.Route(req)
			wantKind(t, err, BadRequest, "routing profile is not served: "+(Profile{goal, c.effective}).Key())
		}
	}
}

func TestServiceRequiresSharedCatalogue(t *testing.T) {
	balanced := mustTable(t, syntheticDocument())
	reordered := syntheticDocument()
	reordered["profile"] = map[string]any{"goal": "cost", "mode": "economy"}
	reordered["classification_choices"] = []any{"provider/reasoning:medium", "provider/fast"}
	otherRepository := syntheticDocument()
	otherRepository["profile"] = map[string]any{"goal": "cost", "mode": "economy"}
	otherRepository["repository"] = "acme/widgets"
	otherCatalogue := syntheticDocument("provider/fast", "provider/reasoning:high")
	otherCatalogue["profile"] = map[string]any{"goal": "cost", "mode": "economy"}
	for name, doc := range map[string]map[string]any{"classifier order": reordered, "repository": otherRepository, "catalogue": otherCatalogue} {
		if _, err := NewService([]*Table{balanced, mustTable(t, doc)}); err == nil || !strings.Contains(err.Error(), "must share one repository") {
			t.Errorf("%s: err = %v", name, err)
		}
	}
	if _, err := NewService([]*Table{balanced, balanced}); err == nil || !strings.Contains(err.Error(), "more than one routing table declares cost/balanced") {
		t.Errorf("duplicate: err = %v", err)
	}
	// A catalogue in another ranking order is still the same catalogue.
	sameCatalogue := syntheticDocument()
	sameCatalogue["profile"] = map[string]any{"goal": "cost", "mode": "economy"}
	group(sameCatalogue, 0)["choices"] = []any{"provider/reasoning:medium", "provider/fast"}
	if _, err := NewService([]*Table{balanced, mustTable(t, sameCatalogue)}); err != nil {
		t.Errorf("reordered ranking: %v", err)
	}
}

func TestBundledProfilesRouteAndClassify(t *testing.T) {
	s, err := LoadService(filepath.Join(routerDir, "routing"))
	if err != nil {
		t.Fatal(err)
	}
	pair := s.primary.Pairs[0]
	for _, p := range Profiles {
		req := &RouteRequest{
			Objective:    &p,
			Conversation: List[Message]{userText("Fix this")},
			Models:       List[ModelCandidate]{candidate("only", pair.Model, pair.Effort)},
		}
		if got := ids(s.Route(req)); !slices.Equal(got, []string{"only"}) {
			t.Errorf("%s: ranked %v", p.Key(), got)
		}
	}

	// The classifier order is the balanced table's order for the classifier cell.
	balanced := s.tables[Profile{GoalCost, ModeBalanced}]
	order := balanced.positions[ClassificationLabels.Key()]
	ranking := slices.SortedFunc(maps.Keys(order), func(a, b Pair) int { return order[a] - order[b] })
	if !slices.Equal(s.primary.Classification, ranking) {
		t.Error("classifier order is not the balanced classifier cell")
	}
	explicit := map[string]bool{}
	for _, p := range ranking {
		if p.Effort != "" {
			explicit[p.Model] = true
		}
	}
	var offered List[ModelChoice]
	for _, p := range ranking {
		if p.Effort != "" || !explicit[p.Model] {
			offered = append(offered, ModelChoice{ID: p.String(), Model: p.Model, Effort: p.Effort})
		}
	}
	alias := offered[0]
	alias.ID = "alias"
	offered = slices.Insert(offered, 1, alias)
	req := &ClassifyRequest{Conversation: List[Message]{userText("Classify this request")}, Models: offered}
	resp, err := s.Classify(req)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(resp.RankedChoices, offered) {
		t.Error("classify did not keep the classifier order")
	}
}

// contractChoices and contractTables port tests/contract_corpus.py, which builds
// the synthetic tables the routing-contract corpus was recorded against.
var contractChoices = []string{"github-copilot/router-fast", "github-copilot/router-reasoning:medium"}

func contractTables(t *testing.T) map[string]*Table {
	t.Helper()
	tables := map[string]*Table{}
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
		// The first label cell decides which group Python creates first.
		if first := allLabelKeys()[0]; !slices.Contains(rankings[0].(map[string]any)["applies_to"].([]any), any(first)) {
			slices.Reverse(rankings)
		}
		doc["rankings"] = rankings
		tables[string(p.Goal)+"-"+string(p.Mode)+".json"] = mustTable(t, doc)
	}
	return tables
}

// TestRoutingContractCorpus replays the corpus's classify and route requests
// through decoding and the service. The HTTP-only cases (other methods, paths
// and headers) belong to the HTTP server's tests.
func TestRoutingContractCorpus(t *testing.T) {
	dir := filepath.Join(routerDir, "tests", "fixtures", "routing-contract")
	files, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		t.Fatal(err)
	}
	tables := contractTables(t)
	ran := 0
	for _, file := range files {
		data, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		var cases []struct {
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
		if json.Unmarshal(data, &cases) != nil {
			continue // not a list of cases, such as a shared response file
		}
		for _, c := range cases {
			if c.Method != "POST" || c.Headers != nil {
				continue
			}
			ran++
			t.Run(c.ID, func(t *testing.T) {
				names := c.Profiles
				if names == nil {
					names = slices.Sorted(maps.Keys(tables))
				}
				var served []*Table
				for _, name := range slices.Sorted(slices.Values(names)) {
					served = append(served, tables[name])
				}
				s, err := NewService(served)
				if err != nil {
					t.Fatal(err)
				}
				body := []byte(c.Request)
				if c.RawRequest != nil {
					body = []byte(*c.RawRequest)
				}
				var result any
				if c.Path == "/classify" {
					var req *ClassifyRequest
					if req, err = DecodeClassifyRequest(body); err == nil {
						result, err = s.Classify(req)
					}
				} else {
					var req *RouteRequest
					if req, err = DecodeRouteRequest(body); err == nil {
						result, err = s.Route(req)
					}
				}
				expected := c.Response
				if c.ResponseFile != "" {
					if expected, err = os.ReadFile(filepath.Join(dir, c.ResponseFile)); err != nil {
						t.Fatal(err)
					}
				}
				if err != nil {
					var e *Error
					if !errors.As(err, &e) {
						t.Fatalf("unexpected error %v", err)
					}
					status, code := e.HTTP()
					var want ErrorResponse
					if err := json.Unmarshal(expected, &want); err != nil {
						t.Fatal(err)
					}
					if status != c.Status || code != want.Code {
						t.Errorf("got %d %s (%v), want %d %s", status, code, err, c.Status, want.Code)
					}
					return
				}
				if c.Status != 200 {
					t.Fatalf("request succeeded, want HTTP %d", c.Status)
				}
				var got, want any
				if err := json.Unmarshal(marshal(t, result), &got); err != nil {
					t.Fatal(err)
				}
				if err := json.Unmarshal(expected, &want); err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(got, want) {
					t.Errorf("response %s\nwant %s", marshal(t, result), expected)
				}
			})
		}
	}
	if ran == 0 {
		t.Fatal("no corpus cases ran")
	}
}
