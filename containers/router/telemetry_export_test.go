package main

import (
	"bytes"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	colmetricpb "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	coltracepb "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/proto"
)

type exportRequest struct {
	path, contentType, authorization string
	body                             []byte
}

// collector is a fake OTLP/HTTP receiver that answers with status, or holds each
// export until the test ends when status is 0.
type collector struct {
	*httptest.Server
	mu       sync.Mutex
	requests []exportRequest
}

func newCollector(t *testing.T, status int) *collector {
	t.Helper()
	return startCollector(t, status, false)
}

// startCollector starts a collector, serving HTTPS with the httptest certificate
// when useTLS is set.
func startCollector(t *testing.T, status int, useTLS bool) *collector {
	t.Helper()
	c := &collector{}
	release := make(chan struct{})
	c.Server = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		c.mu.Lock()
		c.requests = append(c.requests, exportRequest{r.URL.Path, r.Header.Get("Content-Type"), r.Header.Get("Authorization"), body})
		c.mu.Unlock()
		if status == 0 {
			select {
			case <-release:
			case <-r.Context().Done():
			}
			return
		}
		w.WriteHeader(status)
	}))
	if useTLS {
		c.Config.ErrorLog = log.New(io.Discard, "", 0)
		c.StartTLS()
	} else {
		c.Start()
	}
	t.Cleanup(func() {
		close(release)
		c.Close()
	})
	return c
}

func (c *collector) received() []exportRequest {
	c.mu.Lock()
	defer c.mu.Unlock()
	return slices.Clone(c.requests)
}

func (c *collector) paths() []string {
	var paths []string
	for _, r := range c.received() {
		if !slices.Contains(paths, r.path) {
			paths = append(paths, r.path)
		}
	}
	slices.Sort(paths)
	return paths
}

func (c *collector) traces(t *testing.T) []*tracepb.ResourceSpans {
	t.Helper()
	var out []*tracepb.ResourceSpans
	for _, r := range c.received() {
		if r.path == "/v1/traces" {
			var m coltracepb.ExportTraceServiceRequest
			if err := proto.Unmarshal(r.body, &m); err != nil {
				t.Fatal(err)
			}
			out = append(out, m.ResourceSpans...)
		}
	}
	return out
}

func (c *collector) metricNames(t *testing.T) (names, instances []string) {
	t.Helper()
	for _, r := range c.received() {
		if r.path == "/v1/metrics" {
			var m colmetricpb.ExportMetricsServiceRequest
			if err := proto.Unmarshal(r.body, &m); err != nil {
				t.Fatal(err)
			}
			for _, rm := range m.ResourceMetrics {
				instances = append(instances, fmt.Sprint(protoAttrs(rm.Resource.Attributes)["service.instance.id"]))
				for _, sm := range rm.ScopeMetrics {
					for _, metric := range sm.Metrics {
						if !slices.Contains(names, metric.Name) {
							names = append(names, metric.Name)
						}
					}
				}
			}
		}
	}
	slices.Sort(names)
	return names, instances
}

func protoAttrs(kvs []*commonpb.KeyValue) map[string]any {
	out := map[string]any{}
	for _, kv := range kvs {
		switch v := kv.Value.Value.(type) {
		case *commonpb.AnyValue_StringValue:
			out[kv.Key] = v.StringValue
		case *commonpb.AnyValue_IntValue:
			out[kv.Key] = v.IntValue
		case *commonpb.AnyValue_BoolValue:
			out[kv.Key] = v.BoolValue
		default:
			out[kv.Key] = kv.Value.String()
		}
	}
	return out
}

var directClient = &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: 5 * time.Second}

// call sends a request to a running serve and returns the status and body.
func call(t *testing.T, s *served, method, path string, header map[string]string, body []byte) (int, []byte) {
	t.Helper()
	req, err := http.NewRequest(method, "http://"+s.addr+path, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range header {
		req.Header.Set(k, v)
	}
	resp, err := directClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, data
}

func waitListening(t *testing.T, s *served) {
	t.Helper()
	eventually(t, "listening", func() bool { return strings.Contains(s.stderr.String(), `"msg":"listening"`) })
}

func stopServe(t *testing.T, s *served) time.Duration {
	t.Helper()
	s.stop()
	code, elapsed := s.wait()
	if code != 0 {
		t.Errorf("exit %d", code)
	}
	return elapsed
}

// TestTelemetryExportsToTheCollector serves requests for every catalogue entry and
// checks what reaches the collector and the log.
func TestTelemetryExportsToTheCollector(t *testing.T) {
	const canary = "c4n4ry"
	c := newCollector(t, http.StatusOK)
	// The default 60 s metric interval is kept on purpose: the metrics checked below
	// arrive only through the shutdown flush, which short AWF runs rely on.
	s := startInProcessWith(t, 0, map[string]string{
		"OTEL_EXPORTER_OTLP_ENDPOINT": strings.Replace(c.URL, "http://", "http://user-"+canary+":pw@", 1),
		"OTEL_EXPORTER_OTLP_HEADERS":  "authorization=Bearer%20secret-" + canary,
		"OTEL_RESOURCE_ATTRIBUTES":    "service.namespace=awf,host.name=" + canary,
	})
	waitListening(t, s)
	status, body := call(t, s, "GET", "/capabilities", nil, nil)
	var caps Capabilities
	if err := json.Unmarshal(body, &caps); status != 200 || err != nil {
		t.Fatalf("capabilities %d %v", status, err)
	}
	var candidates []any
	models := map[string]bool{}
	for _, m := range caps.ExecutionCatalogue.Models {
		models[m.Model] = true
		if len(m.Efforts) == 0 {
			candidates = append(candidates, map[string]any{"id": canary + strconv.Itoa(len(candidates)), "model": m.Model})
		}
		for _, e := range m.Efforts {
			candidates = append(candidates, map[string]any{"id": canary + strconv.Itoa(len(candidates)), "model": m.Model, "effort": e})
		}
	}
	conversation := []any{
		map[string]any{"role": "user", "parts": []any{map[string]any{"text": "Fix " + canary}}},
		map[string]any{"role": "assistant", "parts": []any{map[string]any{"text": "Calling " + canary},
			map[string]any{"tool_call": map[string]any{"id": canary + "-call", "name": canary + "_tool",
				"input": map[string]any{"path": canary}}}}},
		map[string]any{"role": "user", "parts": []any{map[string]any{"tool_result": map[string]any{
			"id": canary + "-call", "ok": true, "text": canary + " output"}}}},
		map[string]any{"role": "user", "parts": []any{map[string]any{"text": "Then run " + canary}}},
	}
	// tracestate passes through to the router's spans, as W3C propagation requires.
	header := map[string]string{"Content-Type": "application/json", "Traceparent": callerTraceparent,
		"Authorization": "Bearer " + canary, "User-Agent": canary, "X-" + canary: canary,
		"Tracestate": "vendor=opaque", "Baggage": "b=" + canary}
	status, _ = call(t, s, "POST", "/classify?"+canary, header, marshal(t, map[string]any{"conversation": conversation, "models": candidates}))
	if status != 200 {
		t.Errorf("classify %d", status)
	}
	for _, p := range caps.RoutingProfiles {
		payload := map[string]any{"conversation": conversation, "models": candidates, "current_id": canary + "0",
			"objective": map[string]any{"goal": p.Goal, "mode": p.Mode}}
		if status, body := call(t, s, "POST", "/route", header, marshal(t, payload)); status != 200 {
			t.Errorf("route %v: %d %s", p, status, body)
		}
	}
	call(t, s, "GET", "/"+canary, header, nil)
	if elapsed := stopServe(t, s); elapsed > time.Second {
		t.Errorf("stopped after %v", elapsed)
	}

	if paths := c.paths(); !slices.Equal(paths, []string{"/v1/metrics", "/v1/traces"}) {
		t.Fatalf("paths %v", paths)
	}
	for _, r := range c.received() {
		if r.contentType != "application/x-protobuf" || r.authorization != "Bearer secret-"+canary {
			t.Errorf("%s: content type %q, authorization %q", r.path, r.contentType, r.authorization)
		}
		if bytes.Contains(r.body, []byte(canary)) {
			t.Errorf("%s export holds request data", r.path)
		}
	}
	wantMetrics := []string{"gh_aw_router.planning.outcomes", "http.server.request.duration"}
	names, instances := c.metricNames(t)
	if !slices.Equal(names, wantMetrics) {
		t.Errorf("metrics %v", names)
	}
	servers, children := map[string]string{}, 0
	for _, rs := range c.traces(t) {
		res := protoAttrs(rs.Resource.Attributes)
		if res["service.name"] != serviceName || res["service.version"] != version || res["service.namespace"] != "awf" ||
			res["host.name"] != nil {
			t.Errorf("resource %v", res)
		}
		instances = append(instances, fmt.Sprint(res["service.instance.id"]))
		for _, ss := range rs.ScopeSpans {
			if ss.Scope.Name != instrumentationScope || ss.Scope.Version != version {
				t.Errorf("scope %v", ss.Scope)
			}
			for _, span := range ss.Spans {
				attrs := protoAttrs(span.Attributes)
				switch span.Kind {
				case tracepb.Span_SPAN_KIND_SERVER:
					servers[string(span.SpanId)] = span.Name
					if span.Name != "GET /capabilities" && (fmt.Sprintf("%x", span.ParentSpanId) != callerSpanID ||
						span.TraceState != "vendor=opaque") {
						t.Errorf("%s parent %x, trace state %q", span.Name, span.ParentSpanId, span.TraceState)
					}
				case tracepb.Span_SPAN_KIND_INTERNAL:
					children++
					if model, ok := attrs["gh_aw_router.selected.model"]; ok && !models[model.(string)] {
						t.Errorf("selected %v", model)
					}
				}
			}
		}
	}
	for _, rs := range c.traces(t) {
		for _, ss := range rs.ScopeSpans {
			for _, span := range ss.Spans {
				if span.Kind == tracepb.Span_SPAN_KIND_INTERNAL &&
					servers[string(span.ParentSpanId)] != "POST "+strings.Replace(span.Name, "gh_aw_router.", "/", 1) {
					t.Errorf("%s parent %q", span.Name, servers[string(span.ParentSpanId)])
				}
			}
		}
	}
	if len(servers) != 3+len(caps.RoutingProfiles) || children != 1+len(caps.RoutingProfiles) {
		t.Errorf("%d server spans, %d child spans", len(servers), children)
	}
	if slices.Sort(instances); len(instances) < 2 || instances[0] != instances[len(instances)-1] || len(instances[0]) != 36 {
		t.Errorf("instance ids %v", instances)
	}
	logs := s.stderr.String()
	if strings.Contains(logs, canary) || strings.Contains(logs, "secret") {
		t.Errorf("request data or settings reach the log: %s", logs)
	}
	configured := s.stderr.find(t, "telemetry configured")
	if len(configured) != 1 || configured[0]["traces_endpoint"] != c.URL || configured[0]["metrics_endpoint"] != c.URL {
		t.Errorf("records %v", configured)
	}
	if errors := s.stderr.find(t, "telemetry error"); len(errors) != 0 {
		t.Errorf("records %v", errors)
	}
}

func TestTelemetryDisabledExportsNothing(t *testing.T) {
	c := newCollector(t, http.StatusOK)
	for _, tc := range []struct {
		name  string
		env   map[string]string
		paths []string
	}{
		{"no endpoint", map[string]string{"OTEL_TRACES_EXPORTER": "otlp"}, nil},
		{"SDK disabled", map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": c.URL, "OTEL_SDK_DISABLED": "true"}, nil},
		{"both exporters none", map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": c.URL,
			"OTEL_TRACES_EXPORTER": "none", "OTEL_METRICS_EXPORTER": "none"}, nil},
		{"gRPC", map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": c.URL, "OTEL_EXPORTER_OTLP_PROTOCOL": "grpc"}, nil},
		{"traces only", map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": c.URL, "OTEL_METRICS_EXPORTER": "none"},
			[]string{"/v1/traces"}},
		{"metrics only", map[string]string{"OTEL_EXPORTER_OTLP_METRICS_ENDPOINT": c.URL + "/v1/metrics"},
			[]string{"/v1/metrics"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := len(c.received())
			s := startInProcessWith(t, 0, tc.env)
			waitListening(t, s)
			if status, _ := call(t, s, "GET", "/capabilities", nil, nil); status != 200 {
				t.Errorf("status %d", status)
			}
			stopServe(t, s)
			var paths []string
			for _, r := range c.received()[before:] {
				if !slices.Contains(paths, r.path) {
					paths = append(paths, r.path)
				}
			}
			if !slices.Equal(paths, tc.paths) {
				t.Errorf("paths %v", paths)
			}
		})
	}
}

// TestTelemetryUnavailableCollector checks that a collector that is down, failing
// or stalled never slows requests or shutdown, and is reported without detail.
func TestTelemetryUnavailableCollector(t *testing.T) {
	closed := "http://127.0.0.1:" + strconv.Itoa(freePort(t))
	for _, tc := range []struct {
		name, endpoint, reason string
	}{
		{"connection refused", closed, "connection refused"},
		{"failing", newCollector(t, http.StatusServiceUnavailable).URL, "HTTP 503"},
		{"stalled", newCollector(t, 0).URL, "timeout"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// The exporter retries until the metric export timeout, which is short so
			// that exports fail before shutdown, which would cancel them unreported.
			s := startInProcessWith(t, 0, map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": tc.endpoint,
				"OTEL_METRIC_EXPORT_INTERVAL": "50", "OTEL_METRIC_EXPORT_TIMEOUT": "200", "OTEL_EXPORTER_OTLP_TIMEOUT": "5000"})
			waitListening(t, s)
			for range 20 {
				start := time.Now()
				if status, _ := call(t, s, "GET", "/capabilities", nil, nil); status != 200 {
					t.Errorf("status %d", status)
				}
				if d := time.Since(start); d > 250*time.Millisecond {
					t.Errorf("request took %v", d)
				}
				time.Sleep(10 * time.Millisecond)
			}
			eventually(t, "metrics export failure", func() bool {
				return strings.Contains(s.stderr.String(), `"signal":"metrics"`)
			})
			if elapsed := stopServe(t, s); elapsed > time.Second {
				t.Errorf("stopped after %v", elapsed)
			}
			if len(s.stderr.find(t, "telemetry flush incomplete")) != 1 {
				t.Errorf("records %s", s.stderr.String())
			}
			bySignal := map[string]int{}
			for _, r := range s.stderr.find(t, "telemetry error") {
				bySignal[r["signal"].(string)]++
				if r["level"] != "WARN" || r["reason"] != tc.reason {
					t.Errorf("record %v", r)
				}
			}
			for signal, n := range bySignal {
				if n > 1 || signal != "traces" && signal != "metrics" {
					t.Errorf("%d %s records", n, signal)
				}
			}
			if bySignal["metrics"] != 1 {
				t.Errorf("records %s", s.stderr.String())
			}
		})
	}
}

// TestTelemetryCertificate checks that OTEL_EXPORTER_OTLP_CERTIFICATE reaches the
// exporters' TLS client, and that a collector without it is reported without detail.
func TestTelemetryCertificate(t *testing.T) {
	c := startCollector(t, http.StatusOK, true)
	certFile := filepath.Join(t.TempDir(), "collector.pem")
	if err := os.WriteFile(certFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: c.Certificate().Raw}), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Run("trusted", func(t *testing.T) {
		s := startInProcessWith(t, 0, map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": c.URL,
			"OTEL_EXPORTER_OTLP_CERTIFICATE": certFile})
		waitListening(t, s)
		if status, _ := call(t, s, "GET", "/capabilities", nil, nil); status != 200 {
			t.Errorf("status %d", status)
		}
		stopServe(t, s)
		if paths := c.paths(); !slices.Equal(paths, []string{"/v1/metrics", "/v1/traces"}) {
			t.Errorf("paths %v", paths)
		}
		if names, _ := c.metricNames(t); !slices.Contains(names, "http.server.request.duration") {
			t.Errorf("metrics %v", names)
		}
		if len(s.stderr.find(t, "telemetry error")) != 0 || len(s.stderr.find(t, "telemetry flush incomplete")) != 0 {
			t.Errorf("records %s", s.stderr.String())
		}
	})
	t.Run("untrusted", func(t *testing.T) {
		before := len(c.received())
		s := startInProcessWith(t, 0, map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": c.URL,
			"OTEL_METRIC_EXPORT_INTERVAL": "50"})
		waitListening(t, s)
		if status, _ := call(t, s, "GET", "/capabilities", nil, nil); status != 200 {
			t.Errorf("status %d", status)
		}
		eventually(t, "metrics export failure", func() bool {
			return strings.Contains(s.stderr.String(), `"signal":"metrics"`)
		})
		stopServe(t, s)
		if n := len(c.received()); n != before {
			t.Errorf("%d exports reached an untrusted collector", n-before)
		}
		records := s.stderr.find(t, "telemetry error")
		if len(records) == 0 {
			t.Errorf("records %s", s.stderr.String())
		}
		for _, r := range records {
			if r["level"] != "WARN" || r["reason"] != "other" {
				t.Errorf("record %v", r)
			}
		}
		if logs := s.stderr.String(); strings.Contains(logs, "x509") || strings.Contains(logs, "certificate") {
			t.Errorf("error text reaches the log: %s", logs)
		}
	})
}

// TestTelemetryShutdownStaysWithinASecond checks the drain and flush budget with a
// collector that never answers.
func TestTelemetryShutdownStaysWithinASecond(t *testing.T) {
	endpoint := newCollector(t, 0).URL
	t.Run("in process", func(t *testing.T) {
		testShutdown(t, func(t *testing.T, hold time.Duration) *served {
			return startInProcessWith(t, hold, map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": endpoint})
		}, "SIGINT")
	})
	t.Run("SIGTERM", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("Windows has no SIGTERM")
		}
		testShutdown(t, func(t *testing.T, hold time.Duration) *served {
			return startProcessWith(t, hold, "OTEL_EXPORTER_OTLP_ENDPOINT="+endpoint)
		}, "SIGTERM")
	})
}
