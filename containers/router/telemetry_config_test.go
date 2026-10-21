package main

import (
	"context"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"net"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/google/uuid"
	"go.opentelemetry.io/otel/attribute"
	semconv "go.opentelemetry.io/otel/semconv/v1.43.0"
)

func envFunc(env map[string]string) func(string) string {
	return func(name string) string { return env[name] }
}

func endpointOf(s *signalSettings) string {
	if s == nil {
		return ""
	}
	return s.endpoint.String()
}

func resourceAttrs(c telemetryConfig) map[string]string {
	out := map[string]string{}
	for _, kv := range c.resource.Attributes() {
		out[string(kv.Key)] = kv.Value.Emit()
	}
	return out
}

func TestTelemetryConfigEndpoints(t *testing.T) {
	const base = "http://collector:4318"
	for _, c := range []struct {
		name            string
		env             map[string]string
		traces, metrics string
		warnings        []telemetryWarning
	}{
		{"no endpoint", nil, "", "", nil},
		{"blank endpoint", map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": "  "}, "", "", nil},
		{"settings without an endpoint aren't checked", map[string]string{"OTEL_EXPORTER_OTLP_PROTOCOL": "grpc", "OTEL_TRACES_SAMPLER": "x"}, "", "", nil},
		{"shared endpoint", map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": base}, base + "/v1/traces", base + "/v1/metrics", nil},
		{"shared endpoint with a path", map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": base + "/otlp/"},
			base + "/otlp/v1/traces", base + "/otlp/v1/metrics", nil},
		{"signal endpoint is used as is", map[string]string{"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT": "https://traces.example/custom"},
			"https://traces.example/custom", "", nil},
		{"signal endpoint overrides the shared one", map[string]string{
			"OTEL_EXPORTER_OTLP_ENDPOINT": base, "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT": "http://metrics:9000/m"},
			base + "/v1/traces", "http://metrics:9000/m", nil},
		{"SDK disabled", map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": base, "OTEL_SDK_DISABLED": "TRUE"}, "", "", nil},
		{"SDK not disabled", map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": base, "OTEL_SDK_DISABLED": "false"},
			base + "/v1/traces", base + "/v1/metrics", nil},
		{"invalid SDK disabled", map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": base, "OTEL_SDK_DISABLED": "yes"},
			base + "/v1/traces", base + "/v1/metrics", []telemetryWarning{{"OTEL_SDK_DISABLED", "ignored"}}},
		{"both exporters none", map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": base,
			"OTEL_TRACES_EXPORTER": "none", "OTEL_METRICS_EXPORTER": "none"}, "", "", nil},
		{"traces exporter none", map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": base, "OTEL_TRACES_EXPORTER": "none"},
			"", base + "/v1/metrics", nil},
		{"explicit otlp exporter", map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": base, "OTEL_METRICS_EXPORTER": "otlp"},
			base + "/v1/traces", base + "/v1/metrics", nil},
		{"unsupported exporter", map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": base, "OTEL_METRICS_EXPORTER": "prometheus"},
			base + "/v1/traces", "", []telemetryWarning{{"OTEL_METRICS_EXPORTER", "metrics disabled"}}},
		{"grpc", map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": base, "OTEL_EXPORTER_OTLP_PROTOCOL": "grpc"},
			"", "", []telemetryWarning{{"OTEL_EXPORTER_OTLP_PROTOCOL", "traces and metrics disabled"}}},
		{"http/json for traces", map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": base, "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL": "http/json"},
			"", base + "/v1/metrics", []telemetryWarning{{"OTEL_EXPORTER_OTLP_TRACES_PROTOCOL", "traces disabled"}}},
		{"signal protocol overrides the shared one", map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": base,
			"OTEL_EXPORTER_OTLP_PROTOCOL": "grpc", "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL": "http/protobuf"},
			base + "/v1/traces", "", []telemetryWarning{{"OTEL_EXPORTER_OTLP_PROTOCOL", "metrics disabled"}}},
		{"explicit http/protobuf", map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": base, "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf"},
			base + "/v1/traces", base + "/v1/metrics", nil},
		{"unsupported scheme", map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": "ftp://collector"},
			"", "", []telemetryWarning{{"OTEL_EXPORTER_OTLP_ENDPOINT", "traces and metrics disabled"}}},
		{"no host", map[string]string{"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT": "http:///v1/traces"},
			"", "", []telemetryWarning{{"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "traces disabled"}}},
		{"no scheme", map[string]string{"OTEL_EXPORTER_OTLP_METRICS_ENDPOINT": "collector:4318"},
			"", "", []telemetryWarning{{"OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "metrics disabled"}}},
	} {
		t.Run(c.name, func(t *testing.T) {
			cfg := loadTelemetryConfig(envFunc(c.env))
			if endpointOf(cfg.traces) != c.traces || endpointOf(cfg.metrics) != c.metrics || !slices.Equal(cfg.warnings, c.warnings) {
				t.Errorf("traces %q, metrics %q, warnings %v", endpointOf(cfg.traces), endpointOf(cfg.metrics), cfg.warnings)
			}
			if (cfg.traces != nil || cfg.metrics != nil) != (cfg.resource != nil) {
				t.Errorf("resource %v", cfg.resource)
			}
		})
	}
}

// writeCertificate writes a test server's certificate as PEM.
func writeCertificate(t *testing.T) (string, *x509.Certificate) {
	t.Helper()
	srv := httptest.NewTLSServer(nil)
	defer srv.Close()
	cert := srv.Certificate()
	path := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Raw}), 0o600); err != nil {
		t.Fatal(err)
	}
	return path, cert
}

func TestTelemetryConfigExporterSettings(t *testing.T) {
	const base = "http://collector:4318"
	certPath, _ := writeCertificate(t)
	notPEM := filepath.Join(t.TempDir(), "not.pem")
	if err := os.WriteFile(notPEM, []byte("not a certificate"), 0o600); err != nil {
		t.Fatal(err)
	}
	with := func(env map[string]string) map[string]string {
		env["OTEL_EXPORTER_OTLP_ENDPOINT"] = base
		return env
	}
	for _, c := range []struct {
		name     string
		env      map[string]string
		check    func(*testing.T, telemetryConfig)
		warnings []telemetryWarning
	}{
		{"defaults", with(map[string]string{}), func(t *testing.T, c telemetryConfig) {
			if c.traces.timeout != 10*time.Second || len(c.traces.headers) != 0 || c.traces.headers == nil || c.traces.roots != nil ||
				c.interval != time.Minute || c.exportTimeout != 30*time.Second {
				t.Errorf("%+v %+v", c.traces, c)
			}
		}, nil},
		{"headers", with(map[string]string{"OTEL_EXPORTER_OTLP_HEADERS": " api-key = a%20b%2Cc ,x-tenant=t1,,"}), func(t *testing.T, c telemetryConfig) {
			want := map[string]string{"api-key": "a b,c", "x-tenant": "t1"}
			if !maps.Equal(c.traces.headers, want) || !maps.Equal(c.metrics.headers, want) {
				t.Errorf("%v %v", c.traces.headers, c.metrics.headers)
			}
		}, nil},
		{"signal headers replace the shared ones", with(map[string]string{
			"OTEL_EXPORTER_OTLP_HEADERS": "a=1", "OTEL_EXPORTER_OTLP_TRACES_HEADERS": "b=2"}), func(t *testing.T, c telemetryConfig) {
			if !maps.Equal(c.traces.headers, map[string]string{"b": "2"}) || !maps.Equal(c.metrics.headers, map[string]string{"a": "1"}) {
				t.Errorf("%v %v", c.traces.headers, c.metrics.headers)
			}
		}, nil},
		{"header without a value", with(map[string]string{"OTEL_EXPORTER_OTLP_HEADERS": "api-key"}), nil,
			[]telemetryWarning{{"OTEL_EXPORTER_OTLP_HEADERS", "traces and metrics disabled"}}},
		{"header name that isn't a token", with(map[string]string{"OTEL_EXPORTER_OTLP_METRICS_HEADERS": "api key=1"}), nil,
			[]telemetryWarning{{"OTEL_EXPORTER_OTLP_METRICS_HEADERS", "metrics disabled"}}},
		{"bad percent encoding", with(map[string]string{"OTEL_EXPORTER_OTLP_HEADERS": "a=%zz"}), nil,
			[]telemetryWarning{{"OTEL_EXPORTER_OTLP_HEADERS", "traces and metrics disabled"}}},
		{"header value with a newline", with(map[string]string{"OTEL_EXPORTER_OTLP_HEADERS": "a=x%0Ay"}), nil,
			[]telemetryWarning{{"OTEL_EXPORTER_OTLP_HEADERS", "traces and metrics disabled"}}},
		{"timeouts", with(map[string]string{"OTEL_EXPORTER_OTLP_TIMEOUT": "2500", "OTEL_EXPORTER_OTLP_METRICS_TIMEOUT": "100"}),
			func(t *testing.T, c telemetryConfig) {
				if c.traces.timeout != 2500*time.Millisecond || c.metrics.timeout != 100*time.Millisecond {
					t.Errorf("%v %v", c.traces.timeout, c.metrics.timeout)
				}
			}, nil},
		{"zero timeout", with(map[string]string{"OTEL_EXPORTER_OTLP_TIMEOUT": "0"}), nil,
			[]telemetryWarning{{"OTEL_EXPORTER_OTLP_TIMEOUT", "traces and metrics disabled"}}},
		{"timeout in seconds", with(map[string]string{"OTEL_EXPORTER_OTLP_TRACES_TIMEOUT": "10s"}), nil,
			[]telemetryWarning{{"OTEL_EXPORTER_OTLP_TRACES_TIMEOUT", "traces disabled"}}},
		{"certificate", with(map[string]string{"OTEL_EXPORTER_OTLP_CERTIFICATE": certPath}), func(t *testing.T, c telemetryConfig) {
			if c.traces.roots == nil || c.metrics.roots == nil {
				t.Error("no roots")
			}
		}, nil},
		{"missing certificate", with(map[string]string{"OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE": filepath.Join(t.TempDir(), "missing")}), nil,
			[]telemetryWarning{{"OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE", "traces disabled"}}},
		{"certificate that isn't PEM", with(map[string]string{"OTEL_EXPORTER_OTLP_CERTIFICATE": notPEM}), nil,
			[]telemetryWarning{{"OTEL_EXPORTER_OTLP_CERTIFICATE", "traces and metrics disabled"}}},
		{"metric interval", with(map[string]string{"OTEL_METRIC_EXPORT_INTERVAL": "15000", "OTEL_METRIC_EXPORT_TIMEOUT": "5000"}),
			func(t *testing.T, c telemetryConfig) {
				if c.interval != 15*time.Second || c.exportTimeout != 5*time.Second {
					t.Errorf("%v %v", c.interval, c.exportTimeout)
				}
			}, nil},
		{"negative metric interval", with(map[string]string{"OTEL_METRIC_EXPORT_INTERVAL": "-1"}), nil,
			[]telemetryWarning{{"OTEL_METRIC_EXPORT_INTERVAL", "metrics disabled"}}},
		{"metric timeout that isn't a number", with(map[string]string{"OTEL_METRIC_EXPORT_TIMEOUT": "soon"}), nil,
			[]telemetryWarning{{"OTEL_METRIC_EXPORT_TIMEOUT", "metrics disabled"}}},
	} {
		t.Run(c.name, func(t *testing.T) {
			cfg := loadTelemetryConfig(envFunc(c.env))
			if !slices.Equal(cfg.warnings, c.warnings) {
				t.Errorf("warnings %v, want %v", cfg.warnings, c.warnings)
			}
			if c.check != nil {
				if cfg.traces == nil || cfg.metrics == nil {
					t.Fatalf("traces %v, metrics %v", cfg.traces, cfg.metrics)
				}
				c.check(t, cfg)
			}
		})
	}
}

func TestTelemetryConfigSampler(t *testing.T) {
	for _, c := range []struct {
		sampler, arg, want string
		warning            *telemetryWarning
	}{
		{"", "", "ParentBased{root:AlwaysOnSampler,", nil},
		{"parentbased_always_on", "", "ParentBased{root:AlwaysOnSampler,", nil},
		{"ALWAYS_ON", "", "AlwaysOnSampler", nil},
		{"always_off", "0.5", "AlwaysOffSampler", nil},
		{"parentbased_always_off", "", "ParentBased{root:AlwaysOffSampler,", nil},
		{"traceidratio", "", "TraceIDRatioBased{1}", nil},
		{"traceidratio", "0.25", "TraceIDRatioBased{0.25}", nil},
		{"parentbased_traceidratio", "0", "ParentBased{root:TraceIDRatioBased{0},", nil},
		{"traceidratio", "1.5", "", &telemetryWarning{"OTEL_TRACES_SAMPLER_ARG", "traces disabled"}},
		{"parentbased_traceidratio", "NaN", "", &telemetryWarning{"OTEL_TRACES_SAMPLER_ARG", "traces disabled"}},
		{"jaeger_remote", "", "", &telemetryWarning{"OTEL_TRACES_SAMPLER", "traces disabled"}},
	} {
		cfg := loadTelemetryConfig(envFunc(map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": "http://collector:4318",
			"OTEL_TRACES_SAMPLER": c.sampler, "OTEL_TRACES_SAMPLER_ARG": c.arg}))
		if c.warning != nil {
			if cfg.traces != nil || cfg.metrics == nil || !slices.Equal(cfg.warnings, []telemetryWarning{*c.warning}) {
				t.Errorf("%s %s: traces %v, warnings %v", c.sampler, c.arg, cfg.traces, cfg.warnings)
			}
			continue
		}
		if cfg.traces == nil || len(cfg.warnings) != 0 || !strings.HasPrefix(cfg.sampler.Description(), c.want) {
			t.Errorf("%s %s: %v, warnings %v", c.sampler, c.arg, cfg.sampler, cfg.warnings)
		}
	}
}

func TestTelemetryConfigResource(t *testing.T) {
	endpoint := map[string]string{"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT": "http://collector:4318/v1/traces"}
	with := func(extra map[string]string) map[string]string {
		env := maps.Clone(endpoint)
		maps.Copy(env, extra)
		return env
	}
	identity := map[string]string{
		string(semconv.ServiceNameKey): serviceName, string(semconv.ServiceVersionKey): version,
		"telemetry.sdk.name": "opentelemetry", "telemetry.sdk.language": "go",
	}
	plus := func(extra map[string]string) map[string]string {
		m := maps.Clone(identity)
		maps.Copy(m, extra)
		return m
	}
	for _, c := range []struct {
		name     string
		env      map[string]string
		want     map[string]string
		warnings []telemetryWarning
	}{
		{"default", endpoint, identity, nil},
		{"service name", with(map[string]string{"OTEL_SERVICE_NAME": "awf-router"}),
			plus(map[string]string{"service.name": "awf-router"}), nil},
		{"allowed attributes", with(map[string]string{"OTEL_RESOURCE_ATTRIBUTES": "service.namespace=awf,deployment.environment.name=ci%20eu"}),
			plus(map[string]string{"service.namespace": "awf", "deployment.environment.name": "ci eu"}), nil},
		{"other keys are ignored", with(map[string]string{
			"OTEL_RESOURCE_ATTRIBUTES": "service.version=9,service.name=x,host.name=c4n4ry,service.namespace=awf"}),
			plus(map[string]string{"service.namespace": "awf"}),
			[]telemetryWarning{{"OTEL_RESOURCE_ATTRIBUTES", "other keys ignored"}}},
		{"malformed attributes", with(map[string]string{"OTEL_RESOURCE_ATTRIBUTES": "service.namespace"}), identity,
			[]telemetryWarning{{"OTEL_RESOURCE_ATTRIBUTES", "ignored"}}},
	} {
		t.Run(c.name, func(t *testing.T) {
			cfg := loadTelemetryConfig(envFunc(c.env))
			got := resourceAttrs(cfg)
			if id, err := uuid.Parse(got["service.instance.id"]); err != nil || id.Version() != 4 {
				t.Errorf("instance id %q", got["service.instance.id"])
			}
			delete(got, "service.instance.id")
			delete(got, "telemetry.sdk.version")
			if !maps.Equal(got, c.want) || !slices.Equal(cfg.warnings, c.warnings) {
				t.Errorf("resource %v, warnings %v", got, cfg.warnings)
			}
			if cfg.resource.SchemaURL() != semconv.SchemaURL {
				t.Errorf("schema %q", cfg.resource.SchemaURL())
			}
		})
	}
	first, second := resourceAttrs(loadTelemetryConfig(envFunc(endpoint))), resourceAttrs(loadTelemetryConfig(envFunc(endpoint)))
	if first["service.instance.id"] == second["service.instance.id"] {
		t.Errorf("two routers share instance id %q", first["service.instance.id"])
	}
}

func TestTelemetryConfigWarningsHideValues(t *testing.T) {
	const canary = "c4n4ry-otel-value"
	logs := &logBuffer{}
	tel := setupTelemetry(envFunc(map[string]string{
		"OTEL_EXPORTER_OTLP_ENDPOINT":        "https://user-" + canary + ":pw-" + canary + "@collector.example:4318/path-" + canary + "?q=" + canary,
		"OTEL_EXPORTER_OTLP_METRICS_HEADERS": "x-" + canary + "=%zz" + canary,
		"OTEL_TRACES_SAMPLER":                canary,
		"OTEL_RESOURCE_ATTRIBUTES":           canary + "=" + canary,
		"OTEL_SDK_DISABLED":                  canary,
	}), newLogger(logs, slog.LevelDebug))
	defer tel.flush()
	if strings.Contains(logs.String(), canary) {
		t.Errorf("a setting's value reaches the log: %s", logs.String())
	}
	var variables []string
	for _, r := range logs.find(t, "telemetry setting invalid") {
		if r["level"] != "WARN" {
			t.Errorf("record %v", r)
		}
		variables = append(variables, r["variable"].(string))
	}
	want := []string{"OTEL_SDK_DISABLED", "OTEL_EXPORTER_OTLP_METRICS_HEADERS", "OTEL_TRACES_SAMPLER"}
	if !slices.Equal(variables, want) {
		t.Errorf("warned about %v, want %v", variables, want)
	}
	// Both signals are off, so the resource attributes were never read.
	configured := logs.find(t, "telemetry configured")
	if len(configured) != 1 || configured[0]["traces"] != "disabled" || configured[0]["metrics"] != "disabled" ||
		configured[0]["protocol"] != nil || tel.enabled() {
		t.Errorf("records %s", logs.String())
	}
}

func TestTelemetryConfiguredRecordShowsOnlyTheOrigin(t *testing.T) {
	logs := &logBuffer{}
	tel := setupTelemetry(envFunc(map[string]string{
		"OTEL_EXPORTER_OTLP_ENDPOINT":         "https://user:secret@collector.example:4318/base?token=secret",
		"OTEL_EXPORTER_OTLP_METRICS_ENDPOINT": "http://127.0.0.1:1/v1/metrics",
	}), newLogger(logs, slog.LevelDebug))
	defer tel.flush()
	r := logs.find(t, "telemetry configured")
	if len(r) != 1 || r[0]["traces"] != "enabled" || r[0]["metrics"] != "enabled" || r[0]["protocol"] != "http/protobuf" ||
		r[0]["traces_endpoint"] != "https://collector.example:4318" || r[0]["metrics_endpoint"] != "http://127.0.0.1:1" {
		t.Errorf("records %s", logs.String())
	}
	if strings.Contains(logs.String(), "secret") || !tel.enabled() || tel.tracer == nil {
		t.Errorf("records %s", logs.String())
	}
}

func TestTelemetryOffStartsNothing(t *testing.T) {
	before := runtime.NumGoroutine()
	logs := &logBuffer{}
	tel := setupTelemetry(envFunc(map[string]string{"OTEL_SERVICE_NAME": "x", "OTEL_TRACES_SAMPLER": "bad"}), newLogger(logs, slog.LevelDebug))
	if tel.enabled() || tel.tracer != nil || runtime.NumGoroutine() > before {
		t.Errorf("telemetry %+v, goroutines %d > %d", tel, runtime.NumGoroutine(), before)
	}
	if records := logs.records(t); len(records) != 1 || records[0]["msg"] != "telemetry configured" {
		t.Errorf("records %s", logs.String())
	}
}

func attrValues(kvs []attribute.KeyValue) map[string]any {
	out := map[string]any{}
	for _, kv := range kvs {
		out[string(kv.Key)] = kv.Value.AsInterface()
	}
	return out
}

func TestExportFailureReason(t *testing.T) {
	refused := &net.OpError{Op: "dial", Err: os.NewSyscallError("connect", syscall.ECONNREFUSED)}
	timeout := &net.OpError{Op: "read", Err: os.ErrDeadlineExceeded}
	for _, c := range []struct {
		err    error
		status int32
		want   string
	}{
		{errors.New("export failed: 503 Service Unavailable"), 503, "HTTP 503"},
		{fmt.Errorf("wrapped: %w", context.DeadlineExceeded), 429, "HTTP 429"},
		{fmt.Errorf("wrapped: %w", context.DeadlineExceeded), 0, "timeout"},
		{fmt.Errorf("post: %w", timeout), 0, "timeout"},
		{fmt.Errorf("post: %w", refused), 0, "connection refused"},
		{syscall.Errno(wsaECONNREFUSED), 0, "connection refused"},
		{context.Canceled, 0, "other"},
		{errors.New("x509: certificate signed by unknown authority"), 0, "other"},
	} {
		if got := exportFailureReason(c.err, c.status); got != c.want {
			t.Errorf("%v %d: %q, want %q", c.err, c.status, got, c.want)
		}
	}
}

func TestTelemetryReporter(t *testing.T) {
	logs := &logBuffer{}
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	r := &telemetryReporter{log: newLogger(logs, slog.LevelDebug), now: func() time.Time { return now }, last: map[string]time.Time{}}
	r.Handle(errors.New("before the providers are ready"))
	r.ready.Store(true)
	ctx := context.Background()
	transport := &exportTransport{}
	// Shutdown's cancellation is handled without a record or using the allowance,
	// including when the exporter returns the context's cause.
	canceled := r.exportFailed(ctx, "metrics", transport, fmt.Errorf("post: %w", context.Canceled))
	if _, ok := errors.AsType[*reportedError](canceled); !ok {
		t.Errorf("error %T", canceled)
	}
	r.Handle(canceled)
	stopped, stop := context.WithCancelCause(ctx)
	stop(errors.New("stopped"))
	_ = r.exportFailed(stopped, "metrics", transport, context.Cause(stopped))
	transport.status.Store(503)
	err := r.exportFailed(ctx, "traces", transport, errors.New("https://user:secret@collector: 503"))
	if _, ok := errors.AsType[*reportedError](err); !ok {
		t.Errorf("error %T", err)
	}
	r.Handle(fmt.Errorf("export: %w", err))
	r.Handle(fmt.Errorf("shutdown: %w", context.Canceled))
	_ = r.exportFailed(ctx, "traces", transport, errors.New("again"))
	r.Handle(errors.New("secret sdk error"))
	r.Handle(errors.New("secret sdk error"))
	if r.exportFailed(ctx, "metrics", transport, nil) != nil {
		t.Error("a success is an error")
	}
	_ = r.exportFailed(ctx, "metrics", transport, errors.New("secret export error"))
	now = now.Add(telemetryErrorInterval)
	transport.status.Store(0)
	_ = r.exportFailed(ctx, "traces", transport, context.DeadlineExceeded)
	// The metric reader's timeout has a cause, which the exporter returns.
	expired, cancel := context.WithTimeoutCause(ctx, 0, errors.New("reader export timeout"))
	defer cancel()
	_ = r.exportFailed(expired, "metrics", transport, context.Cause(expired))
	var got []string
	for _, rec := range logs.find(t, "telemetry error") {
		got = append(got, rec["signal"].(string)+" "+rec["reason"].(string))
	}
	if want := []string{"traces HTTP 503", "sdk other", "metrics HTTP 503", "traces timeout", "metrics timeout"}; !slices.Equal(got, want) {
		t.Errorf("records %v, want %v", got, want)
	}
	if strings.Contains(logs.String(), "secret") {
		t.Error("error text reaches the log")
	}
}
