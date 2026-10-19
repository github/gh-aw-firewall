package main

import (
	"encoding/json/v2"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	routeBase    = `{"conversation":[],"models":[],"objective":{"goal":"cost","mode":"balanced"}%s}`
	classifyBase = `{"conversation":[],"models":[]%s}`
)

func TestDecodeRequestRejections(t *testing.T) {
	labels := `"labels":{"task_type":"fix","scope":"local","task_complexity":"easy"}`
	cases := []struct {
		name, body string
		want       Kind
		detail     string
	}{
		{"unknown objective field", `{"conversation":[],"objective":{"goal":"cost","mode":"auto","overrides":{}}}`, Invalid, "overrides"},
		{"null objective overrides", `{"conversation":[],"objective":{"goal":"cost","mode":"auto","overrides":null}}`, Invalid, "overrides"},
		{"critical mode", `{"conversation":[],"objective":{"goal":"cost","mode":"critical"}}`, Invalid, "objective.mode"},
		{"unknown goal", `{"conversation":[],"objective":{"goal":"speed","mode":"auto"}}`, Invalid, "objective.goal"},
		{"uppercase goal", `{"conversation":[],"objective":{"goal":"COST","mode":"auto"}}`, Invalid, "objective.goal"},
		{"objective missing", `{"conversation":[]}`, Invalid, "objective"},
		{"objective null", `{"conversation":[],"objective":null}`, Invalid, "objective"},
		{"conversation missing", `{"models":[],"objective":{"goal":"cost","mode":"balanced"}}`, Invalid, "conversation"},
		{"duplicate ids", `{"conversation":[],"models":[{"id":"same","model":"provider/first"},{"id":"same","model":"provider/second"}],"objective":{"goal":"cost","mode":"balanced"}}`, Invalid, "model choice ids must be unique"},
		{"top-level labels", strings.Replace(routeBase, "%s", ","+labels, 1), Invalid, "labels"},
		{"top-level null labels", strings.Replace(routeBase, "%s", `,"labels":null`, 1), Invalid, "labels"},
		{"repository", strings.Replace(routeBase, "%s", `,"repository":"acme/widgets"`, 1), Invalid, "repository"},
		{"task_id", strings.Replace(routeBase, "%s", `,"task_id":null`, 1), Invalid, "task_id"},
		{"api_version", strings.Replace(routeBase, "%s", `,"api_version":"0.2.0"`, 1), Invalid, "api_version"},
		{"classification auto mode", strings.Replace(routeBase, "%s", `,"classification":{`+labels+`,"mode":"auto"}`, 1), Invalid, "classification.mode"},
		{"classification critical mode", strings.Replace(routeBase, "%s", `,"classification":{`+labels+`,"mode":"critical"}`, 1), Invalid, "classification.mode"},
		{"classification null mode", strings.Replace(routeBase, "%s", `,"classification":{`+labels+`,"mode":null}`, 1), Invalid, "classification.mode"},
		{"classification without mode", strings.Replace(routeBase, "%s", `,"classification":{`+labels+`}`, 1), Invalid, "classification.mode"},
		{"labels extra field", strings.Replace(routeBase, "%s", `,"classification":{"labels":{"task_type":"fix","scope":"local","task_complexity":"easy","extra":1},"mode":"robust"}`, 1), Invalid, "extra"},
		{"label missing", strings.Replace(routeBase, "%s", `,"classification":{"labels":{"task_type":"fix","scope":"local"},"mode":"robust"}`, 1), Invalid, "task_complexity"},
		{"empty effort", `{"conversation":[],"models":[{"id":"a","model":"p/m","effort":""}],"objective":{"goal":"cost","mode":"balanced"}}`, Invalid, "effort"},
		{"text null", `{"conversation":[{"role":"user","parts":[{"text":null}]}],"objective":{"goal":"cost","mode":"balanced"}}`, Invalid, "exactly one"},
		{"tool call null", `{"conversation":[{"role":"user","parts":[{"tool_call":null}]}],"objective":{"goal":"cost","mode":"balanced"}}`, Invalid, "exactly one"},
		{"text with null tool call", `{"conversation":[{"role":"user","parts":[{"text":"Fix this","tool_call":null}]}],"objective":{"goal":"cost","mode":"balanced"}}`, Invalid, "exactly one"},
		{"tool result with null text", `{"conversation":[{"role":"user","parts":[{"tool_result":{"id":"a"},"text":null}]}],"objective":{"goal":"cost","mode":"balanced"}}`, Invalid, "exactly one"},
		{"tool call name null", `{"conversation":[{"role":"user","parts":[{"tool_call":{"id":"a","name":null}}]}],"objective":{"goal":"cost","mode":"balanced"}}`, Invalid, "tool_call"},
		{"tool result without id", `{"conversation":[{"role":"user","parts":[{"tool_result":{"text":"x"}}]}],"objective":{"goal":"cost","mode":"balanced"}}`, Invalid, "tool_result"},
		{"current id empty", strings.Replace(routeBase, "%s", `,"current_id":""`, 1), Invalid, "current_id"},
		{"trailing data", `{"conversation":[],"objective":{"goal":"cost","mode":"balanced"}} {}`, Malformed, "invalid JSON"},
		{"syntax error after schema error", `{"conversation":1,`, Malformed, "invalid JSON"},
		{"repeated objective not merged", `{"conversation":[],"objective":{"goal":"cost"},"objective":{"mode":"balanced"}}`, Invalid, "objective.goal"},
		{"repeated labels not merged", strings.Replace(routeBase, "%s", `,"classification":{`+labels+`,"labels":{"task_type":"fix"},"mode":"robust"}`, 1), Invalid, "classification.labels"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := DecodeRouteRequest([]byte(c.body))
			if KindOf(err) != c.want {
				t.Fatalf("got %v, want kind %d", err, c.want)
			}
			if !strings.Contains(err.Error(), c.detail) {
				t.Errorf("error %q does not mention %q", err, c.detail)
			}
		})
	}
}

func TestDecodeClassifyRequestRejections(t *testing.T) {
	cases := []struct{ name, body, detail string }{
		{"models required", `{"conversation":[]}`, "models"},
		{"models null", `{"conversation":[],"models":null}`, "null"},
		{"context window", `{"conversation":[],"models":[{"id":"a","model":"p/m","context_window":5}]}`, "context_window"},
		{"duplicate ids", `{"conversation":[],"models":[{"id":"same","model":"provider/first"},{"id":"same","model":"provider/second"}]}`, "model choice ids must be unique"},
		{"text with null tool call", `{"conversation":[{"role":"user","parts":[{"text":"Fix this","tool_call":null}]}],"models":[]}`, "exactly one"},
		{"objective", strings.Replace(classifyBase, "%s", `,"objective":{"goal":"cost","mode":"balanced"}`, 1), "objective"},
		{"repository", strings.Replace(classifyBase, "%s", `,"repository":" "`, 1), "repository"},
		{"api_version", strings.Replace(classifyBase, "%s", `,"api_version":"0.2.0"`, 1), "api_version"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := DecodeClassifyRequest([]byte(c.body))
			if KindOf(err) != Invalid {
				t.Fatalf("got %v, want an Invalid error", err)
			}
			if !strings.Contains(err.Error(), c.detail) {
				t.Errorf("error %q does not mention %q", err, c.detail)
			}
		})
	}
}

func TestLastValueWins(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"no repeats unchanged", `{"b": [1, {"c": null}], "a": "x"}`, `{"b": [1, {"c": null}], "a": "x"}`},
		{"last member kept", `{"a":1,"b":2,"a":3}`, `{"b":2,"a":3}`},
		{"objects replaced, not merged", `{"o":{"x":1},"o":{"y":2}}`, `{"o":{"y":2}}`},
		{"nested in arrays", `[{"r":"a","r":"b"},[{"k":1,"k":{}}]]`, `[{"r":"b"},[{"k":{}}]]`},
		{"nested repeats inside a superseded value", `{"o":{"x":1,"x":2},"o":{"x":3,"x":4},"p":5}`, `{"o":{"x":4},"p":5}`},
		{"escaped name repeats plain name", `{"a":1,"\u0061":2}`, `{"\u0061":2}`},
		{"scalars keep their text", `{"d":0,"n":1.0,"e":1e400,"s":"\u00e9","d":1}`, `{"n":1.0,"e":1e400,"s":"\u00e9","d":1}`},
		{"scalar", `-0`, `-0`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := lastValueWins([]byte(c.in))
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != c.want {
				t.Errorf("got %s, want %s", got, c.want)
			}
		})
	}
}

func TestDecodeRouteRequestValues(t *testing.T) {
	body := `{
		"conversation": [
			{"role": "assistant", "parts": [
				{"tool_call": {"id": "c", "name": "t", "input": {"a": [1, 2]}}},
				{"tool_call": {"id": "d", "name": "t", "input": null}},
				{"tool_result": {"id": "c", "text": null, "ok": null}}
			]},
			{"role": "user"}
		],
		"models": [
			{"id": "a", "model": "p/m", "effort": null, "context_window": null},
			{"id": "b", "model": "p/m", "effort": "high", "context_window": 18446744073709551617}
		],
		"objective": {"goal": "cost-speed", "mode": "auto"},
		"current_id": null,
		"classification": null
	}`
	req, err := DecodeRouteRequest([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	parts := req.Conversation[0].Parts
	if got := string(parts[0].ToolCall.Input); got != `{"a": [1, 2]}` {
		t.Errorf("input = %q", got)
	}
	if got := string(parts[1].ToolCall.Input); got != "null" {
		t.Errorf("null input = %q", got)
	}
	if r := parts[2].ToolResult; r.Text != nil || r.OK != nil {
		t.Errorf("null tool result fields decoded as %v, %v", r.Text, r.OK)
	}
	if req.Conversation[1].Parts != nil {
		t.Errorf("omitted parts = %v", req.Conversation[1].Parts)
	}
	if m := req.Models[0]; m.Effort != "" || m.ContextWindow != nil {
		t.Errorf("null effort and context window decoded as %q, %v", m.Effort, m.ContextWindow)
	}
	if m := req.Models[1]; m.Effort != EffortHigh || *m.ContextWindow != math.MaxUint64 {
		t.Errorf("effort %q, context window %d", m.Effort, *m.ContextWindow)
	}
	if req.CurrentID != nil || req.Classification != nil {
		t.Error("null current_id or classification was decoded as set")
	}
	if req.Objective.Key() != "cost-speed/auto" {
		t.Errorf("objective = %s", req.Objective.Key())
	}
}

func TestDecodeRouteRequestDefaultsModels(t *testing.T) {
	req, err := DecodeRouteRequest([]byte(`{"conversation":[],"objective":{"goal":"cost","mode":"robust"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if req.Models == nil || len(req.Models) != 0 {
		t.Errorf("models = %#v, want empty", req.Models)
	}
}

func TestValidModelID(t *testing.T) {
	for id, want := range map[string]bool{
		"provider/model": true, "p/m\n": true, "p/a b": true, "p/é": true,
		"a/b/c": false, "/m": false, "p/": false, "pm": false, "": false,
	} {
		if got := ValidModelID(id); got != want {
			t.Errorf("ValidModelID(%q) = %v", id, got)
		}
	}
}

func TestErrorHTTP(t *testing.T) {
	for kind, want := range map[Kind]struct {
		status int
		code   ErrorCode
	}{
		Malformed:  {400, CodeInvalidJSON},
		Invalid:    {422, CodeInvalidJSON},
		BadRequest: {422, CodeInvalidRequest},
		NoRoute:    {422, CodeNoRoute},
	} {
		status, code := (&Error{Kind: kind}).HTTP()
		if status != want.status || code != want.code {
			t.Errorf("kind %d: got %d %s", kind, status, code)
		}
	}
}

// FuzzDecodeRouteRequest checks that decoding never panics, that every failure has
// a kind, and that an accepted request re-encodes to a request that decodes to the
// same value.
func FuzzDecodeRouteRequest(f *testing.F) {
	for _, seed := range []string{
		fmt.Sprintf(routeBase, ""),
		fmt.Sprintf(routeBase, `,"classification":{"mode":"robust"}`),
		`{"objective":{"goal":"cost","mode":"auto"},"conversation":[{"role":"user","parts":[{"tool_call":{"id":"a","name":"b","input":{"x":[1,2.5e3,null]}}}]}],"models":[{"id":"m","model":"p/m","effort":"none","context_window":1e30}]}`,
	} {
		f.Add([]byte(seed))
	}
	if data, err := os.ReadFile(filepath.Join(routerDir, "examples", "route-request.json")); err == nil {
		f.Add(data)
	}
	f.Fuzz(func(t *testing.T, body []byte) {
		req, err := DecodeRouteRequest(body)
		if err != nil {
			if KindOf(err) != Malformed && KindOf(err) != Invalid {
				t.Fatalf("error without a request kind: %v", err)
			}
			return
		}
		first, err := json.Marshal(req)
		if err != nil {
			t.Fatal(err)
		}
		again, err := DecodeRouteRequest(first)
		if err != nil {
			t.Fatalf("re-encoded request is rejected: %v\n%s", err, first)
		}
		second, err := json.Marshal(again)
		if err != nil {
			t.Fatal(err)
		}
		if string(first) != string(second) {
			t.Fatalf("round trip changed the request:\n%s\n%s", first, second)
		}
	})
}
