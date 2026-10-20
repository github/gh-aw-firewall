package main

import (
	"bytes"
	"encoding/json/v2"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// logBuffer collects a logger's output. Its records are checked against the
// documented schema whenever a test reads them.
type logBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *logBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *logBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

type logRecord = map[string]any

// logFields lists every field each record may have besides the common ones. The
// request record's error_code is the only optional field.
var logFields = map[string][]string{
	"starting":               {"bind", "log_level", "go_version"},
	"configuration invalid":  {"error_code", "error"},
	"routing tables loaded":  {"tables_path", "profiles", "models", "label_cells"},
	"routing tables invalid": {"error_code", "error"},
	"listening":              {"address"},
	"listen failed":          {"error"},
	"request":                {"request_id", "method", "route", "status", "duration_ms", "error_code", "request_bytes", "response_bytes"},
	"panic":                  {"request_id", "route", "stack"},
	"shutting down":          {"signal"},
	"stopped":                {"drained", "duration_ms"},
}

var (
	logTime   = regexp.MustCompile(`^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$`)
	requestID = regexp.MustCompile(`^[0-9a-f]{32}$`)
)

// parseLogRecords parses every line as a JSON record and checks it against the
// field allowlist.
func parseLogRecords(t *testing.T, output string) []logRecord {
	t.Helper()
	var records []logRecord
	for line := range strings.Lines(output) {
		var r logRecord
		if err := json.Unmarshal([]byte(line), &r); err != nil {
			t.Fatalf("log line is not JSON: %q", line)
		}
		allowed, ok := logFields[r["msg"].(string)]
		if !ok {
			t.Fatalf("undocumented record: %s", line)
		}
		if !logTime.MatchString(r["time"].(string)) || r["service"] != serviceName || r["version"] != version {
			t.Errorf("common fields: %s", line)
		}
		if !slices.Contains([]string{"DEBUG", "INFO", "WARN", "ERROR"}, r["level"].(string)) {
			t.Errorf("level: %s", line)
		}
		for key := range r {
			if !slices.Contains([]string{"time", "level", "msg", "service", "version"}, key) && !slices.Contains(allowed, key) {
				t.Errorf("field %q is not allowed: %s", key, line)
			}
		}
		for _, key := range allowed {
			if _, ok := r[key]; !ok && key != "error_code" {
				t.Errorf("field %q is missing: %s", key, line)
			}
		}
		if id, ok := r["request_id"]; ok && !requestID.MatchString(id.(string)) {
			t.Errorf("request_id: %s", line)
		}
		records = append(records, r)
	}
	return records
}

func (l *logBuffer) records(t *testing.T) []logRecord {
	t.Helper()
	return parseLogRecords(t, l.String())
}

func (l *logBuffer) find(t *testing.T, msg string) []logRecord {
	t.Helper()
	var found []logRecord
	for _, r := range l.records(t) {
		if r["msg"] == msg {
			found = append(found, r)
		}
	}
	return found
}

func syntheticService(t *testing.T) *Service {
	t.Helper()
	s, err := NewService([]*Table{mustTable(t, syntheticDocument())})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func newTestServer(t *testing.T, hold func(route string)) (*server, *logBuffer) {
	t.Helper()
	return newTestServerFor(t, syntheticService(t), hold)
}

func newTestServerFor(t *testing.T, service *Service, hold func(route string)) (*server, *logBuffer) {
	t.Helper()
	logs := &logBuffer{}
	s := newServer(service, newLogger(logs, slog.LevelDebug))
	s.hold = hold
	return s, logs
}

// planningPayload is the Python tests' planning_payload fixture.
func planningPayload(command string) map[string]any {
	payload := map[string]any{
		"conversation": []any{map[string]any{"role": "user", "parts": []any{map[string]any{"text": "Fix this function"}}}},
		"models": []any{
			map[string]any{"id": "fast", "model": "provider/fast"},
			map[string]any{"id": "reasoning", "model": "provider/reasoning", "effort": "medium"},
		},
	}
	if command == "route" {
		payload["objective"] = map[string]any{"goal": "cost", "mode": "balanced"}
	}
	return payload
}

type response struct {
	status int
	header http.Header
	body   []byte
}

func (r response) json(t *testing.T) map[string]any {
	t.Helper()
	var v map[string]any
	if err := json.Unmarshal(r.body, &v); err != nil {
		t.Fatalf("status %d body %q: %v", r.status, r.body, err)
	}
	return v
}

// wantError checks an error envelope's status and code.
func (r response) wantError(t *testing.T, status int, code ErrorCode) map[string]any {
	t.Helper()
	if r.status != status {
		t.Fatalf("status %d, want %d: %s", r.status, status, r.body)
	}
	if ct := r.header.Get("Content-Type"); ct != "application/json" {
		t.Errorf("content type %q", ct)
	}
	body := r.json(t)
	if body["code"] != string(code) || len(body) != 2 {
		t.Errorf("body %s, want code %s", r.body, code)
	}
	return body
}

// serveRequest runs one request through the handler.
func serveRequest(t *testing.T, h http.Handler, method, target string, header map[string]string, body io.Reader) response {
	t.Helper()
	req := httptest.NewRequest(method, target, body)
	for k, v := range header {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return response{rec.Code, rec.Result().Header, rec.Body.Bytes()}
}

func postJSON(t *testing.T, h http.Handler, path string, v any) response {
	t.Helper()
	return serveRequest(t, h, http.MethodPost, path, map[string]string{"Content-Type": "application/json"}, bytes.NewReader(marshal(t, v)))
}

// canonical encodes v with sorted object keys.
func canonical(t *testing.T, v any) string {
	t.Helper()
	data, err := json.Marshal(v, json.Deterministic(true))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestHTTPHealthAndCapabilities(t *testing.T) {
	s, logs := newTestServer(t, nil)
	health := serveRequest(t, s, http.MethodGet, "/healthz", nil, nil)
	if health.status != http.StatusNoContent || len(health.body) != 0 {
		t.Errorf("healthz: %+v", health)
	}
	r := serveRequest(t, s, http.MethodGet, "/capabilities", nil, nil)
	if r.status != http.StatusOK || r.header.Get("Content-Type") != "application/json" {
		t.Fatalf("capabilities: %+v", r)
	}
	if want := marshal(t, s.service.Capabilities()); !bytes.Equal(r.body, want) {
		t.Errorf("capabilities body\n%s\nwant\n%s", r.body, want)
	}
	body := r.json(t)
	if body["version"] != version || body["api_versions"] != nil {
		t.Errorf("capabilities: %s", r.body)
	}
	if !strings.Contains(string(r.body), `"model":"provider/reasoning"`) {
		t.Errorf("execution catalogue lacks provider/reasoning: %s", r.body)
	}
	for _, path := range []string{"/openapi.json", "/docs", "/redoc"} {
		serveRequest(t, s, http.MethodGet, path, nil, nil).wantError(t, http.StatusNotFound, CodeNotFound)
	}
	// A successful health check isn't logged; the other requests are.
	var routes []string
	for _, rec := range logs.find(t, "request") {
		routes = append(routes, rec["route"].(string))
	}
	if !slices.Equal(routes, []string{"/capabilities", "unmatched", "unmatched", "unmatched"}) {
		t.Errorf("request records for %v", routes)
	}
}

func TestHTTPPlanningEndpointsMatchTheCLI(t *testing.T) {
	s, _ := newTestServer(t, nil)
	tables := filepath.Join(t.TempDir(), "routing.json")
	if err := os.WriteFile(tables, marshal(t, syntheticDocument()), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, command := range []string{"classify", "route"} {
		payload := planningPayload(command)
		payload["conversation"].([]any)[0].(map[string]any)["parts"] = []any{map[string]any{"text": "Fix the parser é <tag> & more"}}
		r := postJSON(t, s, "/"+command, payload)
		if r.status != http.StatusOK || r.header.Get("Content-Type") != "application/json" {
			t.Fatalf("%s: %d %s", command, r.status, r.body)
		}
		cli := runCLI(t, nil, string(marshal(t, payload)), "--routing-tables", tables, command)
		if cli.code != 0 || string(r.body)+"\n" != cli.stdout {
			t.Errorf("%s differs from the CLI:\n%s\n%s", command, r.body, cli.stdout)
		}
		if !slices.Equal(choiceIDs(t, r), []string{"fast", "reasoning"}) {
			t.Errorf("%s ranked %v", command, choiceIDs(t, r))
		}
		if bytes.Contains(r.body, []byte(`\u003c`)) {
			t.Errorf("%s escapes HTML characters", command)
		}
		if command == "classify" && !bytes.Contains(r.body, []byte("&lt;tag&gt;")) {
			t.Errorf("classify prompt: %s", r.body)
		}
	}
}

func choiceIDs(t *testing.T, r response) []string {
	t.Helper()
	var ids []string
	for _, c := range r.json(t)["ranked_choices"].([]any) {
		ids = append(ids, c.(map[string]any)["id"].(string))
	}
	return ids
}

func TestHTTPSharesJSONDecodingWithTheCLI(t *testing.T) {
	s, _ := newTestServer(t, nil)
	tables := filepath.Join(t.TempDir(), "routing.json")
	if err := os.WriteFile(tables, marshal(t, syntheticDocument()), 0o600); err != nil {
		t.Fatal(err)
	}
	nested := `0`
	for range 250 {
		nested = "[" + nested + "]"
	}
	for _, command := range []string{"classify", "route"} {
		body := func(edit func(last map[string]any, p map[string]any)) string {
			p := planningPayload(command)
			conversation := p["conversation"].([]any)
			edit(conversation[len(conversation)-1].(map[string]any), p)
			raw := string(marshal(t, p))
			raw = strings.Replace(raw, `"SURROGATE"`, `"\ud800"`, 1)
			return strings.Replace(raw, `"NESTED"`, nested, 1)
		}
		cases := map[string]struct {
			body   string
			status int
		}{
			"surrogate": {body(func(last, _ map[string]any) {
				last["parts"] = []any{map[string]any{"text": "SURROGATE"}}
			}), http.StatusBadRequest},
			"invalid-field": {body(func(last, _ map[string]any) { last["role"] = 123 }), http.StatusUnprocessableEntity},
			// Python rejects this depth; Go has no nesting limit, a decision the
			// fixture README records.
			"nested": {body(func(_, p map[string]any) {
				p["conversation"] = append(p["conversation"].([]any), map[string]any{
					"role":  "assistant",
					"parts": []any{map[string]any{"tool_call": map[string]any{"id": "call", "name": "lookup", "input": "NESTED"}}},
				})
			}), http.StatusOK},
		}
		for name, c := range cases {
			r := serveRequest(t, s, http.MethodPost, "/"+command, nil, strings.NewReader(c.body))
			cli := runCLI(t, nil, c.body, "--routing-tables", tables, command)
			if r.status != c.status {
				t.Errorf("%s %s: status %d", command, name, r.status)
				continue
			}
			if c.status == http.StatusOK {
				if cli.code != 0 || string(r.body)+"\n" != cli.stdout {
					t.Errorf("%s %s: CLI %+v", command, name, cli)
				}
				continue
			}
			r.wantError(t, c.status, CodeInvalidJSON)
			if cli.code != 2 || cli.stdout != "" {
				t.Errorf("%s %s: CLI %+v", command, name, cli)
			}
		}
	}
}

func TestHTTPAutoRoutingMatchesTheCLI(t *testing.T) {
	s, _ := newTestServer(t, nil)
	tables := filepath.Join(t.TempDir(), "routing.json")
	if err := os.WriteFile(tables, marshal(t, syntheticDocument()), 0o600); err != nil {
		t.Fatal(err)
	}
	labels := map[string]any{"task_type": "fix", "scope": "local", "task_complexity": "easy"}
	for _, c := range []struct {
		recommendation string
		legacyLabels   bool
		code           ErrorCode
	}{
		{"", false, ""},
		{"balanced", false, ""},
		{"unknown", false, ""},
		{"economy", false, CodeInvalidRequest},
		{"robust", false, CodeInvalidRequest},
		{"auto", false, CodeInvalidJSON},
		{"balanced", true, CodeInvalidJSON},
	} {
		payload := planningPayload("route")
		payload["objective"].(map[string]any)["mode"] = "auto"
		payload["current_id"] = "reasoning"
		if c.recommendation != "" {
			payload["classification"] = map[string]any{"labels": labels, "mode": c.recommendation}
			if c.legacyLabels {
				payload["labels"] = labels
			}
		}
		r := postJSON(t, s, "/route", payload)
		cli := runCLI(t, nil, string(marshal(t, payload)), "--routing-tables", tables, "route")
		if c.code == "" {
			if r.status != http.StatusOK || cli.code != 0 || string(r.body)+"\n" != cli.stdout {
				t.Errorf("%q: HTTP %d %s, CLI %+v", c.recommendation, r.status, r.body, cli)
			}
			if !slices.Equal(choiceIDs(t, r), []string{"reasoning", "fast"}) {
				t.Errorf("%q ranked %v", c.recommendation, choiceIDs(t, r))
			}
			continue
		}
		r.wantError(t, http.StatusUnprocessableEntity, c.code)
		if cli.code != 2 || cli.stdout != "" || !strings.HasPrefix(cli.stderr, "invalid request:") {
			t.Errorf("%q: CLI %+v", c.recommendation, cli)
		}
	}
}

func TestHTTPRequestErrors(t *testing.T) {
	s, _ := newTestServer(t, nil)
	withField := func(command, field string, v any) map[string]any {
		p := planningPayload(command)
		p[field] = v
		return p
	}
	noModels := planningPayload("route")
	noModels["models"] = []any{}
	missingEffort := func(command string) map[string]any {
		p := planningPayload(command)
		p["models"] = []any{map[string]any{"id": "reasoning", "model": "provider/reasoning"}}
		return p
	}
	empty := map[string]any{"conversation": []any{}, "models": []any{}}
	for _, c := range []struct {
		name, path string
		body       any
		status     int
		code       ErrorCode
		detail     string
	}{
		{"unsupported", "/classify", empty, 422, CodeInvalidRequest, ""},
		{"unknown field", "/classify", withField("classify", "extra", true), 422, CodeInvalidJSON, "extra"},
		{"no models", "/route", noModels, 422, CodeNoRoute, ""},
		{"classify without effort", "/classify", missingEffort("classify"), 422, CodeInvalidRequest, "effort"},
		{"route without effort", "/route", missingEffort("route"), 422, CodeNoRoute, "effort"},
	} {
		body := postJSON(t, s, c.path, c.body).wantError(t, c.status, c.code)
		if !strings.Contains(body["detail"].(string), c.detail) {
			t.Errorf("%s: detail %q lacks %q", c.name, body["detail"], c.detail)
		}
	}
	for _, command := range []string{"classify", "route"} {
		for _, field := range []string{"api_version", "repository", "task_id"} {
			body := postJSON(t, s, "/"+command, withField(command, field, "unused")).wantError(t, 422, CodeInvalidJSON)
			if !strings.Contains(body["detail"].(string), field) {
				t.Errorf("%s %s: %q", command, field, body["detail"])
			}
		}
		for _, raw := range []string{"{", "\xff"} {
			r := serveRequest(t, s, http.MethodPost, "/"+command, map[string]string{"Content-Type": "application/json"}, strings.NewReader(raw))
			if r.status != 400 || string(r.body) != `{"code":"invalid_json","detail":"Failed to parse the request body as JSON"}` {
				t.Errorf("%s %q: %d %s", command, raw, r.status, r.body)
			}
		}
	}
	for _, objective := range []map[string]any{
		{"goal": "cost", "mode": "custom"},
		{"goal": "cost-speed", "mode": "custom", "overrides": map[string]any{"cost": 1000}},
		{"goal": "cost", "mode": "balanced", "overrides": nil},
		{"goal": "cost", "mode": "auto", "overrides": map[string]any{"cost": 1000}},
	} {
		body := postJSON(t, s, "/route", withField("route", "objective", objective)).wantError(t, 422, CodeInvalidJSON)
		if !strings.Contains(body["detail"].(string), "objective") {
			t.Errorf("%v: %q", objective, body["detail"])
		}
	}
}

func TestHTTPRouteFiltersUnsupportedChoices(t *testing.T) {
	s, _ := newTestServer(t, nil)
	for _, candidate := range []map[string]any{
		{"id": "unsupported", "model": "provider/unknown"},
		{"id": "unsupported", "model": "provider/reasoning", "effort": "low"},
		{"id": "unsupported", "model": "provider/reasoning"},
	} {
		for _, supported := range []bool{false, true} {
			payload := planningPayload("route")
			expected := payload["models"].([]any)
			if !supported {
				expected = nil
			}
			payload["models"] = append([]any{candidate}, expected...)
			payload["current_id"] = "unsupported"
			r := postJSON(t, s, "/route", payload)
			if !supported {
				r.wantError(t, 422, CodeNoRoute)
				continue
			}
			if r.status != 200 || !slices.Equal(choiceIDs(t, r), []string{"fast", "reasoning"}) {
				t.Errorf("%v: %d %s", candidate, r.status, r.body)
			}
		}
	}
}

func TestHTTPServesItsLoadedProfiles(t *testing.T) {
	request := func(goal, mode string) map[string]any {
		return map[string]any{
			"conversation": []any{map[string]any{"role": "user", "parts": []any{map[string]any{"text": "Fix this function"}}}},
			"models":       []any{map[string]any{"id": "luna", "model": "github-copilot/gpt-5.6-luna", "effort": "medium"}},
			"objective":    map[string]any{"goal": goal, "mode": mode},
		}
	}
	for _, mode := range []string{"economy", "balanced", "robust"} {
		service, err := LoadService(filepath.Join(bundledTables(t), "cost-"+mode+".json"))
		if err != nil {
			t.Fatal(err)
		}
		s, _ := newTestServerFor(t, service, nil)
		caps := serveRequest(t, s, http.MethodGet, "/capabilities", nil, nil).json(t)
		if got := canonical(t, caps["routing_profiles"]); got != `[{"goal":"cost","mode":"`+mode+`"}]` {
			t.Errorf("%s: profiles %s", mode, got)
		}
		for _, goal := range []string{"cost", "cost-speed"} {
			for _, requested := range []string{"economy", "balanced", "robust"} {
				r := postJSON(t, s, "/route", request(goal, requested))
				if goal == "cost" && requested == mode {
					if r.status != 200 {
						t.Errorf("%s/%s: %d %s", goal, requested, r.status, r.body)
					}
					continue
				}
				body := r.wantError(t, 422, CodeInvalidRequest)
				if !strings.Contains(body["detail"].(string), "routing profile is not served") {
					t.Errorf("%s/%s: %q", goal, requested, body["detail"])
				}
			}
		}
		for _, unknown := range [][2]string{{"cost", "critical"}, {"speed", "balanced"}} {
			postJSON(t, s, "/route", request(unknown[0], unknown[1])).wantError(t, 422, CodeInvalidJSON)
		}
	}

	service, err := LoadService(bundledTables(t))
	if err != nil {
		t.Fatal(err)
	}
	s, _ := newTestServerFor(t, service, nil)
	caps := serveRequest(t, s, http.MethodGet, "/capabilities", nil, nil).json(t)
	want := `[{"goal":"cost","mode":"economy"},{"goal":"cost","mode":"balanced"},{"goal":"cost","mode":"robust"},` +
		`{"goal":"cost-speed","mode":"economy"},{"goal":"cost-speed","mode":"balanced"},{"goal":"cost-speed","mode":"robust"}]`
	if got := canonical(t, caps["routing_profiles"]); got != want {
		t.Errorf("published profiles %s", got)
	}
}

func TestHTTPPathsAndMethods(t *testing.T) {
	s, _ := newTestServer(t, nil)
	for _, target := range []string{"/missing", "/healthz/", "/%2Fhealthz", "/HEALTHZ", "/route/", "/classify/x"} {
		r := serveRequest(t, s, http.MethodGet, target, nil, nil)
		if r.status != 404 || string(r.body) != `{"code":"not_found","detail":"Not Found"}` {
			t.Errorf("%s: %d %s", target, r.status, r.body)
		}
	}
	// ServeMux redirects a path that isn't clean, a decision the fixture README records.
	for _, target := range []string{"//healthz", "/a/../healthz", "/./healthz"} {
		r := serveRequest(t, s, http.MethodGet, target, nil, nil)
		if r.status != http.StatusTemporaryRedirect || r.header.Get("Location") != "/healthz" {
			t.Errorf("%s: %d %v", target, r.status, r.header)
		}
	}
	for _, target := range []string{"/%68ealthz", "/healthz?verbose=1", "/healthz?"} {
		if r := serveRequest(t, s, http.MethodGet, target, nil, nil); r.status != 204 {
			t.Errorf("%s: %d %s", target, r.status, r.body)
		}
	}
	routes := map[string]string{"/healthz": "GET", "/capabilities": "GET", "/classify": "POST", "/route": "POST"}
	for path, method := range routes {
		for _, wrong := range []string{"GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "TRACE", "BREW"} {
			if wrong == method {
				continue
			}
			r := serveRequest(t, s, wrong, path, nil, strings.NewReader(""))
			if r.status != 405 || r.header.Get("Allow") != method {
				t.Errorf("%s %s: %d allow %q", wrong, path, r.status, r.header.Get("Allow"))
				continue
			}
			if wrong != http.MethodHead {
				r.wantError(t, 405, CodeMethodNotAllowed)
			}
		}
	}
}

func TestHTTPAcceptsOnlyJSONMediaTypes(t *testing.T) {
	s, _ := newTestServer(t, nil)
	for _, command := range []string{"classify", "route"} {
		body := marshal(t, planningPayload(command))
		for _, c := range []struct {
			contentType string
			status      int
		}{
			{"", 200},
			{"application/json", 200},
			{"application/json; charset=utf-8", 200},
			{"Application/JSON; charset=utf-8", 200},
			{"application/vnd.router+json", 200},
			{"application/vnd.example+json; v=1", 200},
			{"application/json; charset", 200},
			{"text/plain", 415},
			{"multipart/form-data", 415},
			{"application/jsonx", 415},
			{"text/json", 415},
			{"application/json/x", 415},
		} {
			header := map[string]string{}
			if c.contentType != "" {
				header["Content-Type"] = c.contentType
			}
			r := serveRequest(t, s, http.MethodPost, "/"+command, header, bytes.NewReader(body))
			if c.status == 200 {
				if r.status != 200 {
					t.Errorf("%s %q: %d %s", command, c.contentType, r.status, r.body)
				}
				continue
			}
			got := r.wantError(t, 415, CodeUnsupportedMediaType)
			if got["detail"] != "Expected a JSON request body" {
				t.Errorf("415 detail %q", got["detail"])
			}
		}
	}
}

// chunked hides a reader's length, so that a request has no Content-Length.
type chunked struct{ io.Reader }

type brokenBody struct{}

func (brokenBody) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }

func TestHTTPBrokenBodyClosesTheConnection(t *testing.T) {
	s, logs := newTestServer(t, nil)
	defer func() {
		if p := recover(); p != http.ErrAbortHandler {
			t.Errorf("panic %v", p)
		}
		if out := logs.String(); out != "" {
			t.Errorf("logs %s", out)
		}
	}()
	serveRequest(t, s, http.MethodPost, "/route", nil, chunked{brokenBody{}})
	t.Error("the request isn't aborted")
}

func TestHTTPBodyLimit(t *testing.T) {
	s, _ := newTestServer(t, nil)
	const detail = "request body exceeds the 1048576-byte limit"
	for _, c := range []struct{ method, path string }{
		{"GET", "/capabilities"}, {"POST", "/capabilities"}, {"DELETE", "/capabilities"},
		{"GET", "/healthz"}, {"POST", "/missing"}, {"POST", "/route"},
	} {
		req := httptest.NewRequest(c.method, c.path, strings.NewReader(""))
		req.ContentLength = maxBodyBytes + 1
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, req)
		r := response{rec.Code, rec.Result().Header, rec.Body.Bytes()}
		if got := r.wantError(t, 413, CodePayloadTooLarge); got["detail"] != detail {
			t.Errorf("%s %s: %q", c.method, c.path, got["detail"])
		}
		if r.header.Get("Connection") != "close" {
			t.Errorf("%s %s: the connection stays open", c.method, c.path)
		}
	}
	tooLarge := bytes.Repeat([]byte("x"), maxBodyBytes+1)
	for _, body := range []io.Reader{bytes.NewReader(tooLarge), chunked{bytes.NewReader(tooLarge)}} {
		serveRequest(t, s, http.MethodPost, "/route", map[string]string{"Content-Type": "application/json"}, body).
			wantError(t, 413, CodePayloadTooLarge)
	}
	// Other paths answer without reading a chunked upload, unlike Python, which
	// buffers every POST, PUT and PATCH body first.
	for _, c := range []struct {
		method, path string
		status       int
		code         ErrorCode
	}{
		{"POST", "/healthz", 405, CodeMethodNotAllowed},
		{"PUT", "/capabilities", 405, CodeMethodNotAllowed},
		{"PATCH", "/missing", 404, CodeNotFound},
	} {
		serveRequest(t, s, c.method, c.path, nil, chunked{bytes.NewReader(tooLarge)}).wantError(t, c.status, c.code)
	}
	// A body exactly at the limit is served.
	payload := marshal(t, planningPayload("route"))
	exact := append(payload, bytes.Repeat([]byte(" "), maxBodyBytes-len(payload))...)
	for _, body := range []io.Reader{bytes.NewReader(exact), chunked{bytes.NewReader(exact)}} {
		if r := serveRequest(t, s, http.MethodPost, "/route", nil, body); r.status != 200 {
			t.Errorf("body at the limit: %d %s", r.status, r.body)
		}
	}
}

func TestHTTPErrorDetailsAreBoundedAndPrintable(t *testing.T) {
	s, _ := newTestServer(t, nil)
	supreme := planningPayload("route")
	supreme["models"].([]any)[0].(map[string]any)["effort"] = "supreme"
	detail := postJSON(t, s, "/route", supreme).wantError(t, 422, CodeInvalidJSON)["detail"].(string)
	if !strings.Contains(detail, "effort") || strings.Contains(detail, "supreme") {
		t.Errorf("effort detail %q", detail)
	}
	incomplete := planningPayload("route")
	delete(incomplete, "objective")
	if detail := postJSON(t, s, "/route", incomplete).wantError(t, 422, CodeInvalidJSON)["detail"].(string); !strings.Contains(detail, "objective") {
		t.Errorf("missing objective detail %q", detail)
	}

	noisy := planningPayload("route")
	var conversation []any
	for i := range 40 {
		conversation = append(conversation, map[string]any{"role": "user", "parts": []any{map[string]any{"text": "x", "bad\u0007key": i}}})
	}
	noisy["conversation"] = conversation
	long := map[string]any{"api_version": strings.Repeat("x", 2*maxDetailChars), "conversation": []any{}, "models": []any{}}
	for _, body := range []map[string]any{noisy, long} {
		detail := postJSON(t, s, "/route", body).wantError(t, 422, CodeInvalidJSON)["detail"].(string)
		if n := len([]rune(detail)); n > maxDetailChars || strings.ContainsFunc(detail, func(r rune) bool { return r < ' ' || r == 0x7f }) {
			t.Errorf("detail of %d characters: %q", n, detail)
		}
	}
	if strings.Count(sanitizeDetail(strings.Repeat("\u0007", 600)), " ") != maxDetailChars {
		t.Error("control characters aren't replaced and truncated")
	}
}

func TestHTTPPanicReturnsAnInternalError(t *testing.T) {
	const canary = "c4n4ry-panic-7d1f"
	s, logs := newTestServer(t, func(route string) {
		if route == "/capabilities" {
			panic(canary)
		}
	})
	r := serveRequest(t, s, http.MethodGet, "/capabilities", nil, nil)
	if r.status != 500 || string(r.body) != `{"code":"internal_error","detail":"internal error while processing the request"}` {
		t.Fatalf("panic: %d %s", r.status, r.body)
	}
	panics := logs.find(t, "panic")
	if len(panics) != 1 || panics[0]["level"] != "ERROR" || panics[0]["route"] != "/capabilities" ||
		!strings.Contains(panics[0]["stack"].(string), "TestHTTPPanicReturnsAnInternalError") {
		t.Errorf("panic records %v", panics)
	}
	requests := logs.find(t, "request")
	if len(requests) != 1 || requests[0]["level"] != "ERROR" || requests[0]["error_code"] != "internal_error" ||
		requests[0]["request_id"] != panics[0]["request_id"] {
		t.Errorf("request records %v", requests)
	}
	if strings.Contains(logs.String(), canary) {
		t.Error("the panic value reaches the log")
	}
}

func TestHTTPPanicAfterTheResponseStartedAbortsTheConnection(t *testing.T) {
	s, logs := newTestServer(t, nil)
	s.mux.HandleFunc("/started", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		panic("after the response started")
	})
	defer func() {
		if p := recover(); p != http.ErrAbortHandler {
			t.Errorf("panic %v", p)
		}
		if panics := logs.find(t, "panic"); len(panics) != 1 || panics[0]["route"] != "/started" {
			t.Errorf("panic records %v", panics)
		}
		if requests := logs.find(t, "request"); len(requests) != 0 {
			t.Errorf("request records %v", requests)
		}
	}()
	serveRequest(t, s, http.MethodGet, "/started", nil, nil)
	t.Error("the connection isn't aborted")
}

func TestServeUntilSignalReportsServeErrors(t *testing.T) {
	s, logs := newTestServer(t, nil)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	_ = ln.Close()
	if code := s.serveUntilSignal(ln, make(chan os.Signal)); code != 1 {
		t.Errorf("exit %d", code)
	}
	if failed := logs.find(t, "listen failed"); len(failed) != 1 || failed[0]["level"] != "ERROR" {
		t.Errorf("records %s", logs.String())
	}
}

func TestSignalNames(t *testing.T) {
	for sig, want := range map[os.Signal]string{
		syscall.SIGTERM: "SIGTERM",
		os.Interrupt:    "SIGINT",
		syscall.SIGHUP:  syscall.SIGHUP.String(),
	} {
		if got := signalName(sig); got != want {
			t.Errorf("%v: %q", sig, got)
		}
	}
}

func TestHTTPConcurrencyLimit(t *testing.T) {
	entered, release := make(chan struct{}, maxInFlight+1), make(chan struct{})
	s, logs := newTestServer(t, func(string) {
		entered <- struct{}{}
		<-release
	})
	held := make([]response, maxInFlight)
	var wg sync.WaitGroup
	for i := range held {
		wg.Go(func() { held[i] = serveRequest(t, s, http.MethodGet, "/healthz", nil, nil) })
		<-entered
	}
	r := serveRequest(t, s, http.MethodGet, "/healthz", nil, nil)
	if r.status != 503 || string(r.body) != "Service Unavailable" ||
		r.header.Get("Content-Type") != "text/plain; charset=utf-8" || r.header.Get("Connection") != "close" {
		t.Errorf("overload: %d %v %q", r.status, r.header, r.body)
	}
	close(release)
	wg.Wait()
	for i, r := range held {
		if r.status != 204 {
			t.Errorf("request %d: %d", i, r.status)
		}
	}
	if r := serveRequest(t, s, http.MethodGet, "/healthz", nil, nil); r.status != 204 {
		t.Errorf("after the limit: %d", r.status)
	}
	// Successful health checks aren't logged; the rejection is.
	records := logs.find(t, "request")
	if len(records) != 1 || records[0]["status"] != float64(503) || records[0]["route"] != "/healthz" || records[0]["level"] != "ERROR" {
		t.Errorf("request records %v", records)
	}
}

func TestHTTPServerSettings(t *testing.T) {
	s, _ := newTestServer(t, nil)
	srv := s.httpServer()
	if srv.Handler != s || srv.ReadHeaderTimeout != 10*time.Second || srv.ReadTimeout != 30*time.Second ||
		srv.WriteTimeout != 30*time.Second || srv.IdleTimeout != 5*time.Second || srv.MaxHeaderBytes != 0 {
		t.Errorf("server %+v", srv)
	}
	if !srv.Protocols.HTTP1() || srv.Protocols.HTTP2() || srv.Protocols.UnencryptedHTTP2() {
		t.Errorf("protocols %v", srv.Protocols)
	}
	if maxBodyBytes != 1048576 || maxInFlight != 64 || drainTimeout != 500*time.Millisecond {
		t.Error("limits changed")
	}
}

func TestHTTPRequestDataNeverReachesResponsesOrLogs(t *testing.T) {
	const canary = "c4n4ry-9f3a"
	s, logs := newTestServer(t, nil)
	send := func(method, target, contentType string, body []byte) {
		t.Helper()
		header := map[string]string{"Authorization": "Bearer " + canary, "User-Agent": canary, "X-Canary": canary}
		if contentType != "" {
			header["Content-Type"] = contentType
		}
		r := serveRequest(t, s, method, target, header, bytes.NewReader(body))
		if strings.Contains(string(r.body), canary) {
			t.Errorf("%s %s echoes the canary: %s", method, target, r.body)
		}
		for name, values := range r.header {
			if strings.Contains(name, canary) || strings.Contains(strings.Join(values, ","), canary) {
				t.Errorf("%s %s echoes the canary in a header: %s: %v", method, target, name, values)
			}
		}
	}
	text := planningPayload("route")
	text["conversation"].([]any)[0].(map[string]any)["parts"] = []any{map[string]any{"text": canary}}
	effort := planningPayload("route")
	effort["models"].([]any)[0].(map[string]any)["effort"] = canary
	model := planningPayload("route")
	model["models"] = []any{map[string]any{"id": "x", "model": "provider/" + canary}}
	role := planningPayload("classify")
	role["conversation"].([]any)[0].(map[string]any)["role"] = canary
	goal := planningPayload("route")
	goal["objective"] = map[string]any{"goal": canary, "mode": "balanced"}
	for _, body := range []map[string]any{text, effort, model, role, goal} {
		for _, path := range []string{"/route?q=" + canary, "/classify"} {
			send("POST", path, "application/json", marshal(t, body))
		}
	}
	send("POST", "/route", "application/"+canary, marshal(t, text))
	send("POST", "/route", "application/json", []byte(`{"`+canary+`":`))
	send("GET", "/"+canary+"?q="+canary, "", nil)
	send(canary, "/route", "", nil)
	send("GET", "/healthz?"+canary, "", nil)
	if strings.Contains(logs.String(), canary) {
		t.Errorf("the canary reaches the log:\n%s", logs.String())
	}
	methods := map[string]bool{}
	for _, r := range logs.find(t, "request") {
		methods[r["method"].(string)] = true
	}
	if !methods["_OTHER"] || !methods["POST"] || !methods["GET"] {
		t.Errorf("methods %v", methods)
	}
}

func TestHTTPRequestRecords(t *testing.T) {
	s, logs := newTestServer(t, nil)
	body := marshal(t, planningPayload("route"))
	r := serveRequest(t, s, http.MethodPost, "/route", nil, bytes.NewReader(body))
	serveRequest(t, s, http.MethodGet, "/route", nil, nil)
	records := logs.find(t, "request")
	if len(records) != 2 {
		t.Fatalf("records %v", records)
	}
	ok, wrong := records[0], records[1]
	if ok["level"] != "INFO" || ok["method"] != "POST" || ok["route"] != "/route" || ok["status"] != float64(200) ||
		ok["request_bytes"] != float64(len(body)) || ok["response_bytes"] != float64(len(r.body)) || ok["error_code"] != nil {
		t.Errorf("success record %v", ok)
	}
	if wrong["level"] != "INFO" || wrong["status"] != float64(405) || wrong["error_code"] != "method_not_allowed" || ok["request_id"] == wrong["request_id"] {
		t.Errorf("error record %v", wrong)
	}
	// A failed health check is logged.
	failing, failingLogs := newTestServer(t, func(string) { panic("unhealthy") })
	serveRequest(t, failing, http.MethodGet, "/healthz", nil, nil)
	if got := failingLogs.find(t, "request"); len(got) != 1 || got[0]["route"] != "/healthz" || got[0]["status"] != float64(500) {
		t.Errorf("failed health check records %v", got)
	}
}
