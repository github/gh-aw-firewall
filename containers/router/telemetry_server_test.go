package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"go.opentelemetry.io/otel/codes"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

const (
	callerTraceID     = "4bf92f3577b34da6a3ce929d0e0e4736"
	callerSpanID      = "00f067aa0ba902b7"
	callerTraceparent = "00-" + callerTraceID + "-" + callerSpanID + "-01"
)

// tracedServer is a test server whose spans and metrics stay in memory.
type tracedServer struct {
	*server
	logs   *logBuffer
	spans  *tracetest.InMemoryExporter
	reader *sdkmetric.ManualReader
}

func newTracedServer(t *testing.T, hold func(string), sampler sdktrace.Sampler) *tracedServer {
	t.Helper()
	s, logs := newTestServer(t, hold)
	spans, reader := tracetest.NewInMemoryExporter(), sdkmetric.NewManualReader()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSyncer(spans), sdktrace.WithSampler(sampler))
	mp := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	t.Cleanup(func() {
		_ = tp.Shutdown(context.Background())
		_ = mp.Shutdown(context.Background())
	})
	s.tel = newInstruments(tp, mp)
	return &tracedServer{s, logs, spans, reader}
}

// do serves req and returns the response, after recovering an aborted request.
func (ts *tracedServer) do(req *http.Request) (r response, aborted bool) {
	rec := httptest.NewRecorder()
	defer func() {
		if p := recover(); p != nil {
			if p != http.ErrAbortHandler {
				panic(p)
			}
			aborted = true
		}
	}()
	ts.ServeHTTP(rec, req)
	return response{rec.Code, rec.Result().Header, rec.Body.Bytes()}, false
}

// metricSeries maps each metric to its series, keyed by their sorted attributes,
// with a histogram's count or a sum's value.
func (ts *tracedServer) metricSeries(t *testing.T) map[string]map[string]int64 {
	t.Helper()
	var rm metricdata.ResourceMetrics
	if err := ts.reader.Collect(context.Background(), &rm); err != nil {
		t.Fatal(err)
	}
	out := map[string]map[string]int64{}
	for _, sm := range rm.ScopeMetrics {
		if sm.Scope.Name != instrumentationScope || sm.Scope.Version != version {
			t.Errorf("scope %+v", sm.Scope)
		}
		for _, m := range sm.Metrics {
			series := map[string]int64{}
			switch d := m.Data.(type) {
			case metricdata.Histogram[float64]:
				if d.Temporality != metricdata.CumulativeTemporality {
					t.Errorf("%s temporality %v", m.Name, d.Temporality)
				}
				for _, dp := range d.DataPoints {
					if !slices.Equal(dp.Bounds, durationBuckets) {
						t.Errorf("%s bounds %v", m.Name, dp.Bounds)
					}
					series[seriesKey(attrValues(dp.Attributes.ToSlice()))] = int64(dp.Count)
				}
			case metricdata.Sum[int64]:
				for _, dp := range d.DataPoints {
					series[seriesKey(attrValues(dp.Attributes.ToSlice()))] = dp.Value
				}
			default:
				t.Errorf("%s has data %T", m.Name, m.Data)
			}
			out[m.Name] = series
		}
	}
	return out
}

func seriesKey(attrs map[string]any) string {
	var parts []string
	for k, v := range attrs {
		parts = append(parts, fmt.Sprintf("%s=%v", k, v))
	}
	slices.Sort(parts)
	return strings.Join(parts, ",")
}

func lastRequestRecord(t *testing.T, logs *logBuffer) logRecord {
	t.Helper()
	records := logs.find(t, "request")
	if len(records) == 0 {
		t.Fatalf("no request record: %s", logs.String())
	}
	return records[len(records)-1]
}

func jsonRequest(method, target string, body io.Reader) *http.Request {
	req := httptest.NewRequest(method, target, body)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Traceparent", callerTraceparent)
	return req
}

func TestTelemetryRequestSpansAndMetrics(t *testing.T) {
	var boom atomic.Bool
	ts := newTracedServer(t, func(string) {
		if boom.Load() {
			panic("boom")
		}
	}, sdktrace.ParentBased(sdktrace.AlwaysSample()))
	payload := func(command string, edit func(map[string]any)) io.Reader {
		p := planningPayload(command)
		if edit != nil {
			edit(p)
		}
		return bytes.NewReader(marshal(t, p))
	}
	auto := func(p map[string]any) {
		p["objective"] = map[string]any{"goal": "cost", "mode": "auto"}
		p["current_id"] = "reasoning"
		p["classification"] = map[string]any{"mode": "balanced",
			"labels": map[string]any{"task_type": "fix", "scope": "local", "task_complexity": "easy"}}
	}
	tooLarge := bytes.Repeat([]byte("x"), maxBodyBytes+1)
	server := func(method, route string, status int, errorType string) map[string]any {
		m := map[string]any{"http.request.method": method, "url.scheme": "http", "network.protocol.version": "1.1",
			"http.response.status_code": int64(status)}
		if route != "" {
			m["http.route"] = route
		}
		if errorType != "" {
			m["error.type"] = errorType
		}
		return m
	}
	routeChild := func(models int64, mode, resolved, outcome string, extra map[string]any) map[string]any {
		m := map[string]any{"gh_aw_router.conversation.messages": int64(1), "gh_aw_router.models.count": models,
			"gh_aw_router.classification.present": false, "gh_aw_router.goal": "cost", "gh_aw_router.mode": mode,
			"gh_aw_router.resolved_mode": resolved, "gh_aw_router.outcome": outcome}
		for k, v := range extra {
			m[k] = v
		}
		return m
	}
	for _, c := range []struct {
		name      string
		req       func() *http.Request
		panic     bool
		status    int
		span      string
		attrs     map[string]any
		child     string
		childAttr map[string]any
	}{
		{"capabilities", func() *http.Request { return jsonRequest("GET", "/capabilities", nil) }, false, 200,
			"GET /capabilities", server("GET", "/capabilities", 200, ""), "", nil},
		{"classify", func() *http.Request { return jsonRequest("POST", "/classify", payload("classify", nil)) }, false, 200,
			"POST /classify", server("POST", "/classify", 200, ""), "gh_aw_router.classify", map[string]any{
				"gh_aw_router.conversation.messages": int64(1), "gh_aw_router.models.count": int64(2),
				"gh_aw_router.prior_turns.included": int64(0), "gh_aw_router.outcome": "ok"}},
		{"route", func() *http.Request { return jsonRequest("POST", "/route", payload("route", nil)) }, false, 200,
			"POST /route", server("POST", "/route", 200, ""), "gh_aw_router.route",
			routeChild(2, "balanced", "balanced", "ok", map[string]any{"gh_aw_router.selected.model": "provider/fast"})},
		{"auto route", func() *http.Request { return jsonRequest("POST", "/route", payload("route", auto)) }, false, 200,
			"POST /route", server("POST", "/route", 200, ""), "gh_aw_router.route",
			routeChild(2, "auto", "balanced", "ok", map[string]any{"gh_aw_router.classification.present": true,
				"gh_aw_router.task_type": "fix", "gh_aw_router.scope": "local", "gh_aw_router.task_complexity": "easy",
				"gh_aw_router.mode_recommendation": "balanced", "gh_aw_router.selected.model": "provider/reasoning",
				"gh_aw_router.selected.effort": "medium"})},
		{"invalid JSON", func() *http.Request { return jsonRequest("POST", "/route", strings.NewReader("{")) }, false, 400,
			"POST /route", server("POST", "/route", 400, "invalid_json"), "", nil},
		{"invalid classify request", func() *http.Request {
			return jsonRequest("POST", "/classify", strings.NewReader(`{"conversation":[],"models":[]}`))
		}, false, 422, "POST /classify", server("POST", "/classify", 422, "invalid_request"), "gh_aw_router.classify",
			map[string]any{"gh_aw_router.conversation.messages": int64(0), "gh_aw_router.models.count": int64(0),
				"gh_aw_router.outcome": "invalid_request"}},
		{"invalid route request", func() *http.Request {
			return jsonRequest("POST", "/route", payload("route", func(p map[string]any) {
				p["objective"] = map[string]any{"goal": "cost", "mode": "robust"}
			}))
		}, false, 422, "POST /route", server("POST", "/route", 422, "invalid_request"), "gh_aw_router.route",
			routeChild(2, "robust", "robust", "invalid_request", nil)},
		{"no route", func() *http.Request {
			return jsonRequest("POST", "/route", payload("route", func(p map[string]any) { p["models"] = []any{} }))
		}, false, 422, "POST /route", server("POST", "/route", 422, "no_route"), "gh_aw_router.route",
			routeChild(0, "balanced", "balanced", "no_route", nil)},
		{"not found", func() *http.Request { return jsonRequest("GET", "/missing/c4n4ry?q=c4n4ry", nil) }, false, 404,
			"GET", server("GET", "", 404, "not_found"), "", nil},
		{"method not allowed", func() *http.Request { return jsonRequest("DELETE", "/capabilities", nil) }, false, 405,
			"DELETE /capabilities", server("DELETE", "/capabilities", 405, "method_not_allowed"), "", nil},
		{"unknown method", func() *http.Request { return jsonRequest("BREW", "/capabilities", nil) }, false, 405,
			"_OTHER /capabilities", server("_OTHER", "/capabilities", 405, "method_not_allowed"), "", nil},
		{"POST health check", func() *http.Request { return jsonRequest("POST", "/healthz", nil) }, false, 405,
			"POST /healthz", server("POST", "/healthz", 405, "method_not_allowed"), "", nil},
		{"declared body too large", func() *http.Request {
			req := jsonRequest("POST", "/route", strings.NewReader(""))
			req.ContentLength = maxBodyBytes + 1
			return req
		}, false, 413, "POST /route", server("POST", "/route", 413, "payload_too_large"), "", nil},
		{"chunked body too large", func() *http.Request {
			req := jsonRequest("POST", "/route", io.MultiReader(bytes.NewReader(tooLarge)))
			req.ContentLength = -1
			return req
		}, false, 413, "POST /route", server("POST", "/route", 413, "payload_too_large"), "", nil},
		{"unsupported media type", func() *http.Request {
			req := jsonRequest("POST", "/route", payload("route", nil))
			req.Header.Set("Content-Type", "text/plain")
			return req
		}, false, 415, "POST /route", server("POST", "/route", 415, "unsupported_media_type"), "", nil},
		{"panic", func() *http.Request { return jsonRequest("GET", "/capabilities", nil) }, true, 500,
			"GET /capabilities", server("GET", "/capabilities", 500, "internal_error"), "", nil},
		{"health check", func() *http.Request { return jsonRequest("GET", "/healthz", nil) }, false, 204, "", nil, "", nil},
	} {
		t.Run(c.name, func(t *testing.T) {
			ts.spans.Reset()
			boom.Store(c.panic)
			defer boom.Store(false)
			if r, aborted := ts.do(c.req()); aborted || r.status != c.status {
				t.Fatalf("status %d, aborted %v: %s", r.status, aborted, r.body)
			}
			spans := ts.spans.GetSpans()
			if c.span == "" {
				if len(spans) != 0 {
					t.Errorf("spans %v", spans)
				}
				return
			}
			want := 1
			if c.child != "" {
				want = 2
			}
			if len(spans) != want {
				t.Fatalf("%d spans", len(spans))
			}
			srv := spans[len(spans)-1]
			if srv.Name != c.span || srv.SpanKind != trace.SpanKindServer || !srv.Parent.IsRemote() ||
				srv.Parent.TraceID().String() != callerTraceID || srv.Parent.SpanID().String() != callerSpanID {
				t.Errorf("server span %q kind %v parent %v", srv.Name, srv.SpanKind, srv.Parent)
			}
			if got := attrValues(srv.Attributes); seriesKey(got) != seriesKey(c.attrs) {
				t.Errorf("server attributes\n got %v\nwant %v", got, c.attrs)
			}
			wantStatus := codes.Unset
			if c.status >= 500 {
				wantStatus = codes.Error
			}
			if srv.Status.Code != wantStatus || srv.Status.Description != "" || len(srv.Events) != 0 {
				t.Errorf("server status %v, events %v", srv.Status, srv.Events)
			}
			if srv.InstrumentationScope.Name != instrumentationScope || srv.InstrumentationScope.Version != version {
				t.Errorf("scope %+v", srv.InstrumentationScope)
			}
			if c.child != "" {
				child := spans[0]
				if child.Name != c.child || child.SpanKind != trace.SpanKindInternal || child.Parent.SpanID() != srv.SpanContext.SpanID() ||
					child.Status.Code != codes.Unset {
					t.Errorf("child %q kind %v parent %v status %v", child.Name, child.SpanKind, child.Parent, child.Status)
				}
				if got := attrValues(child.Attributes); seriesKey(got) != seriesKey(c.childAttr) {
					t.Errorf("child attributes\n got %v\nwant %v", got, c.childAttr)
				}
			}
			r := lastRequestRecord(t, ts.logs)
			if r["trace_id"] != callerTraceID || r["span_id"] != srv.SpanContext.SpanID().String() {
				t.Errorf("record %v, span %v", r, srv.SpanContext)
			}
		})
	}
	m := ts.metricSeries(t)
	for key, n := range m["http.server.active_requests"] {
		if n != 0 {
			t.Errorf("active requests %s: %d", key, n)
		}
	}
	durations := m["http.server.request.duration"]
	var total int64
	for _, n := range durations {
		total += n
	}
	for key, n := range map[string]int64{
		seriesKey(map[string]any{"http.request.method": "GET", "http.route": "/healthz", "http.response.status_code": int64(204)}):  1,
		seriesKey(map[string]any{"http.request.method": "GET", "http.response.status_code": int64(404), "error.type": "not_found"}): 1,
		seriesKey(map[string]any{"http.request.method": "_OTHER", "http.route": "/capabilities", "http.response.status_code": int64(405),
			"error.type": "method_not_allowed"}): 1,
		seriesKey(map[string]any{"http.request.method": "POST", "http.route": "/route", "http.response.status_code": int64(413),
			"error.type": "payload_too_large"}): 2,
		seriesKey(map[string]any{"http.request.method": "POST", "http.route": "/route", "http.response.status_code": int64(200)}): 2,
	} {
		if durations[key] != n {
			t.Errorf("duration series %s: %d, want %d", key, durations[key], n)
		}
	}
	if total != 17 {
		t.Errorf("%d requests measured: %v", total, durations)
	}
	if want := map[string]int64{"gh_aw_router.reason=payload_too_large": 2}; !mapsEqual(m["gh_aw_router.requests.rejected"], want) {
		t.Errorf("rejected %v", m["gh_aw_router.requests.rejected"])
	}
	route := func(mode, resolved, outcome string) string {
		return seriesKey(map[string]any{"gh_aw_router.operation": "route", "gh_aw_router.outcome": outcome,
			"gh_aw_router.goal": "cost", "gh_aw_router.mode": mode, "gh_aw_router.resolved_mode": resolved})
	}
	classify := func(outcome string) string {
		return seriesKey(map[string]any{"gh_aw_router.operation": "classify", "gh_aw_router.outcome": outcome})
	}
	want := map[string]int64{
		classify("ok"): 1, classify("invalid_request"): 1, route("balanced", "balanced", "ok"): 1,
		route("auto", "balanced", "ok"): 1, route("robust", "robust", "invalid_request"): 1,
		route("balanced", "balanced", "no_route"): 1,
	}
	if !mapsEqual(m["gh_aw_router.planning.outcomes"], want) {
		t.Errorf("outcomes\n got %v\nwant %v", m["gh_aw_router.planning.outcomes"], want)
	}
	if strings.Contains(fmt.Sprint(m, ts.spans.GetSpans()), "c4n4ry") || strings.Contains(ts.logs.String(), "c4n4ry") {
		t.Error("the request path reaches telemetry or logs")
	}
}

func mapsEqual(a, b map[string]int64) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if bv, ok := b[k]; !ok || bv != v {
			return false
		}
	}
	return true
}

func TestTelemetryAbortedRequest(t *testing.T) {
	ts := newTracedServer(t, nil, sdktrace.AlwaysSample())
	req := jsonRequest("POST", "/route", chunked{brokenBody{}})
	if _, aborted := ts.do(req); !aborted {
		t.Fatal("the request isn't aborted")
	}
	spans := ts.spans.GetSpans()
	if len(spans) != 1 || spans[0].Status.Code != codes.Error ||
		seriesKey(attrValues(spans[0].Attributes)) != seriesKey(map[string]any{"http.request.method": "POST", "http.route": "/route",
			"url.scheme": "http", "network.protocol.version": "1.1", "error.type": "request_aborted"}) {
		t.Errorf("spans %v", spans)
	}
	want := map[string]int64{seriesKey(map[string]any{"http.request.method": "POST", "http.route": "/route",
		"error.type": "request_aborted"}): 1}
	if got := ts.metricSeries(t)["http.server.request.duration"]; !mapsEqual(got, want) {
		t.Errorf("durations %v", got)
	}
	if ts.logs.String() != "" {
		t.Errorf("records %s", ts.logs.String())
	}
}

func TestTelemetryPanicAfterTheResponseStarted(t *testing.T) {
	ts := newTracedServer(t, nil, sdktrace.AlwaysSample())
	ts.mux.HandleFunc("/started", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		panic("after the response started")
	})
	if _, aborted := ts.do(jsonRequest("GET", "/started", nil)); !aborted {
		t.Fatal("the request isn't aborted")
	}
	spans := ts.spans.GetSpans()
	if len(spans) != 1 || spans[0].Name != "GET /started" || spans[0].Status.Code != codes.Error ||
		seriesKey(attrValues(spans[0].Attributes)) != seriesKey(map[string]any{"http.request.method": "GET", "http.route": "/started",
			"url.scheme": "http", "network.protocol.version": "1.1", "error.type": "internal_error"}) {
		t.Errorf("spans %v", spans)
	}
}

func TestTelemetryOverload(t *testing.T) {
	entered, release := make(chan struct{}, maxInFlight), make(chan struct{})
	ts := newTracedServer(t, func(string) {
		entered <- struct{}{}
		<-release
	}, sdktrace.AlwaysSample())
	var wg sync.WaitGroup
	for range maxInFlight {
		wg.Go(func() { ts.do(jsonRequest("GET", "/capabilities", nil)) })
		<-entered
	}
	if r, _ := ts.do(jsonRequest("GET", "/capabilities", nil)); r.status != 503 {
		t.Errorf("status %d", r.status)
	}
	if r := lastRequestRecord(t, ts.logs); r["status"] != float64(503) || r["trace_id"] != callerTraceID || r["span_id"] != nil {
		t.Errorf("record %v", r)
	}
	close(release)
	wg.Wait()
	spans := ts.spans.GetSpans()
	if len(spans) != maxInFlight {
		t.Errorf("%d spans", len(spans))
	}
	for _, s := range spans {
		if attrValues(s.Attributes)["http.response.status_code"] != int64(200) {
			t.Errorf("span %v", s.Attributes)
		}
	}
	m := ts.metricSeries(t)
	if want := map[string]int64{"gh_aw_router.reason=overload": 1}; !mapsEqual(m["gh_aw_router.requests.rejected"], want) {
		t.Errorf("rejected %v", m["gh_aw_router.requests.rejected"])
	}
	key := seriesKey(map[string]any{"http.request.method": "GET", "http.route": "/capabilities",
		"http.response.status_code": int64(503), "error.type": "503"})
	if m["http.server.request.duration"][key] != 1 {
		t.Errorf("durations %v", m["http.server.request.duration"])
	}
}

func TestTraceContextWithoutTracing(t *testing.T) {
	s, logs := newTestServer(t, nil)
	if s.tel.tracer != nil || s.tel.enabled() {
		t.Fatal("telemetry is on by default")
	}
	for _, c := range []struct{ traceparent, want string }{
		{callerTraceparent, callerTraceID},
		{"", ""},
		{"00-" + callerTraceID + "-" + callerSpanID, ""},
		{"00-" + strings.Repeat("0", 32) + "-" + callerSpanID + "-01", ""},
		{"00-" + callerTraceID + "-" + strings.Repeat("0", 16) + "-01", ""},
		{"ff-" + callerTraceID + "-" + callerSpanID + "-01", ""},
	} {
		headers := map[string]string{"Tracestate": "vendor=c4n4ry", "Baggage": "user=c4n4ry"}
		if c.traceparent != "" {
			headers["Traceparent"] = c.traceparent
		}
		serveRequest(t, s, http.MethodGet, "/capabilities", headers, nil)
		r := lastRequestRecord(t, logs)
		if c.want == "" && r["trace_id"] != nil || c.want != "" && r["trace_id"] != c.want || r["span_id"] != nil {
			t.Errorf("%q: record %v", c.traceparent, r)
		}
	}
	if strings.Contains(logs.String(), "c4n4ry") {
		t.Error("tracestate or baggage reaches the log")
	}
}

func TestTraceContextWithTracing(t *testing.T) {
	ts := newTracedServer(t, nil, sdktrace.ParentBased(sdktrace.AlwaysSample()))
	req := jsonRequest("GET", "/capabilities", nil)
	req.Header.Set("Traceparent", "00-not-a-trace-01")
	req.Header.Set("Baggage", "user=c4n4ry")
	ts.do(req)
	spans := ts.spans.GetSpans()
	if len(spans) != 1 || spans[0].Parent.IsValid() {
		t.Fatalf("spans %v", spans)
	}
	r := lastRequestRecord(t, ts.logs)
	if r["trace_id"] != spans[0].SpanContext.TraceID().String() || r["span_id"] != spans[0].SpanContext.SpanID().String() {
		t.Errorf("record %v", r)
	}
	req = jsonRequest("GET", "/capabilities", nil)
	req.Header.Set("Baggage", "user=c4n4ry")
	req.Header.Set("Tracestate", "vendor=c4n4ry")
	ts.do(req)
	spans = ts.spans.GetSpans()
	if len(spans) != 2 || spans[1].SpanContext.TraceID().String() != callerTraceID {
		t.Fatalf("spans %v", spans)
	}
	for _, s := range spans {
		if strings.Contains(fmt.Sprint(s.Attributes, s.Events, s.Links, s.Name), "c4n4ry") {
			t.Errorf("span %v", s)
		}
	}
	if strings.Contains(ts.logs.String(), "c4n4ry") {
		t.Error("tracestate or baggage reaches the log")
	}
}

func TestTraceContextUnsampled(t *testing.T) {
	ts := newTracedServer(t, nil, sdktrace.NeverSample())
	ts.do(jsonRequest("GET", "/capabilities", nil))
	if spans := ts.spans.GetSpans(); len(spans) != 0 {
		t.Errorf("spans %v", spans)
	}
	// The local span isn't recorded, but its id still correlates the log.
	if r := lastRequestRecord(t, ts.logs); r["trace_id"] != callerTraceID || r["span_id"] == nil || r["span_id"] == callerSpanID {
		t.Errorf("record %v", r)
	}
}

// TestTelemetryCardinality sends random requests and checks that no request data
// becomes an attribute value and that the series stay bounded.
func TestTelemetryCardinality(t *testing.T) {
	ts := newTracedServer(t, nil, sdktrace.AlwaysSample())
	rng := rand.New(rand.NewPCG(1, 2))
	random := func() string { return fmt.Sprintf("rnd%d", rng.IntN(1_000_000)) }
	pick := func(values ...string) string { return values[rng.IntN(len(values))] }
	methods := []string{"GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH", "TRACE", "CONNECT", "QUERY"}
	var spans int
	for range 3000 {
		method := methods[rng.IntN(len(methods))]
		if rng.IntN(4) == 0 {
			method = "RND" + strings.ToUpper(random()[3:])
		}
		path := pick("/healthz", "/capabilities", "/classify", "/route", "/"+random(), "/route/"+random())
		p := planningPayload(pick("classify", "route"))
		p["models"].([]any)[0].(map[string]any)["id"] = random()
		switch rng.IntN(5) {
		case 0:
			p["objective"] = map[string]any{"goal": random(), "mode": "balanced"}
		case 1:
			p["objective"] = map[string]any{"goal": "cost", "mode": pick("auto", "balanced", "robust", "economy")}
			p["classification"] = map[string]any{"mode": pick("balanced", "robust", "economy", "unknown"),
				"labels": map[string]any{"task_type": pick("fix", random()), "scope": "local", "task_complexity": "easy"}}
		case 2:
			p["current_id"] = random()
		case 3:
			p["conversation"] = []any{map[string]any{"role": "user", "parts": []any{map[string]any{"text": random()}}}}
		}
		req := httptest.NewRequest(method, path+"?"+random(), bytes.NewReader(marshal(t, p)))
		req.Header.Set("Content-Type", pick("application/json", "text/"+random()))
		req.Header.Set(random(), random())
		ts.do(req)
		got := ts.spans.GetSpans()
		spans += len(got)
		for _, s := range got {
			if strings.Contains(strings.ToLower(fmt.Sprint(s.Name, s.Attributes)), "rnd") {
				t.Fatalf("span %s %v", s.Name, s.Attributes)
			}
		}
		ts.spans.Reset()
	}
	m := ts.metricSeries(t)
	if strings.Contains(strings.ToLower(fmt.Sprint(m)), "rnd") {
		t.Fatalf("metrics %v", m)
	}
	series := 0
	for _, s := range m {
		series += len(s)
	}
	// Methods times routes times statuses, plus the planning outcomes.
	if series > 10*5*12+100 || spans < 2000 {
		t.Errorf("%d series, %d spans: %v", series, spans, m)
	}
}
