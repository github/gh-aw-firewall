package main

import (
	"cmp"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"log/slog"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/go-logr/logr"
	"github.com/google/uuid"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/metric"
	metricnoop "go.opentelemetry.io/otel/metric/noop"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.43.0"
	"go.opentelemetry.io/otel/trace"
)

const (
	instrumentationScope = "github.com/github/gh-aw-firewall/containers/router"
	telemetryProtocol    = "http/protobuf"
	// With telemetry on, a shutdown drains HTTP for telemetryDrainTimeout and then
	// flushes for telemetryFlushTimeout, so that the process exits within the 1 s
	// AWF allows between SIGTERM and SIGKILL.
	telemetryDrainTimeout  = 250 * time.Millisecond
	telemetryFlushTimeout  = 500 * time.Millisecond
	telemetryErrorInterval = time.Minute
	defaultExportTimeout   = 10 * time.Second
	defaultMetricInterval  = 60 * time.Second
	defaultMetricTimeout   = 30 * time.Second
	spanQueueSize          = 2048
	spanBatchSize          = 512
	spanBatchDelay         = 5 * time.Second
	spanExportTimeout      = 30 * time.Second
	// wsaECONNREFUSED is Windows' connection refused error, which syscall.ECONNREFUSED
	// doesn't match there.
	wsaECONNREFUSED = 10061
)

// The router's own span and metric attributes. Every value comes from a fixed set.
const (
	attrOperation             = attribute.Key("gh_aw_router.operation")
	attrOutcome               = attribute.Key("gh_aw_router.outcome")
	attrReason                = attribute.Key("gh_aw_router.reason")
	attrMessages              = attribute.Key("gh_aw_router.conversation.messages")
	attrModels                = attribute.Key("gh_aw_router.models.count")
	attrPriorTurns            = attribute.Key("gh_aw_router.prior_turns.included")
	attrGoal                  = attribute.Key("gh_aw_router.goal")
	attrMode                  = attribute.Key("gh_aw_router.mode")
	attrResolvedMode          = attribute.Key("gh_aw_router.resolved_mode")
	attrClassificationPresent = attribute.Key("gh_aw_router.classification.present")
	attrTaskType              = attribute.Key("gh_aw_router.task_type")
	attrScope                 = attribute.Key("gh_aw_router.scope")
	attrTaskComplexity        = attribute.Key("gh_aw_router.task_complexity")
	attrModeRecommendation    = attribute.Key("gh_aw_router.mode_recommendation")
	attrSelectedModel         = attribute.Key("gh_aw_router.selected.model")
	attrSelectedEffort        = attribute.Key("gh_aw_router.selected.effort")
)

// The planning outcomes, and the error.type of a request whose body never arrived.
const (
	outcomeOK             = "ok"
	outcomeInvalidRequest = "invalid_request"
	outcomeNoRoute        = "no_route"
	outcomeInternalError  = "internal_error"
	requestAborted        = "request_aborted"
)

// durationBuckets are semconv's advisory boundaries for http.server.request.duration.
var durationBuckets = []float64{0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10}

// traceContext extracts W3C traceparent and tracestate. The router never reads
// baggage and never injects context, because it makes no outbound calls.
var traceContext = propagation.TraceContext{}

// telemetry holds the router's tracer and instruments. The tracer is nil when
// tracing is off, and the instruments are no-ops when metrics are off.
type telemetry struct {
	tracer   trace.Tracer
	duration metric.Float64Histogram
	rejected metric.Int64Counter
	outcomes metric.Int64Counter
	// stops shut down the SDK providers. It is empty when telemetry is off.
	stops []func(context.Context) error
}

// newInstruments creates the tracer and instruments. A nil tracer provider turns
// tracing off, and a nil meter provider turns metrics off.
func newInstruments(tp trace.TracerProvider, mp metric.MeterProvider) *telemetry {
	t := &telemetry{}
	if tp != nil {
		t.tracer = tp.Tracer(instrumentationScope, trace.WithInstrumentationVersion(version),
			trace.WithSchemaURL(semconv.SchemaURL))
	}
	if mp == nil {
		mp = metricnoop.NewMeterProvider()
	}
	m := mp.Meter(instrumentationScope, metric.WithInstrumentationVersion(version), metric.WithSchemaURL(semconv.SchemaURL))
	// The names, units and boundaries are valid, so these never fail.
	t.duration, _ = m.Float64Histogram("http.server.request.duration", metric.WithUnit("s"),
		metric.WithDescription("Duration of HTTP server requests."), metric.WithExplicitBucketBoundaries(durationBuckets...))
	t.rejected, _ = m.Int64Counter("gh_aw_router.requests.rejected", metric.WithUnit("{request}"),
		metric.WithDescription("Requests rejected by the in-flight limit or the body limit."))
	t.outcomes, _ = m.Int64Counter("gh_aw_router.planning.outcomes", metric.WithUnit("{request}"),
		metric.WithDescription("Outcomes of decoded classify and route requests."))
	return t
}

func (t *telemetry) enabled() bool { return len(t.stops) > 0 }

// flush shuts the providers down in parallel, within telemetryFlushTimeout in
// total, and reports whether they all finished without an error.
func (t *telemetry) flush() bool {
	ctx, cancel := context.WithTimeout(context.Background(), telemetryFlushTimeout)
	defer cancel()
	results := make(chan error, len(t.stops))
	for _, stop := range t.stops {
		go func() { results <- stop(ctx) }()
	}
	ok := true
	for range t.stops {
		select {
		case err := <-results:
			ok = ok && err == nil
		case <-ctx.Done():
			return false
		}
	}
	return ok
}

// setupTelemetry reads the OTEL_* settings, logs any that are invalid and the
// resulting state, and starts the SDK providers for the signals that are on. It
// touches no OpenTelemetry global state when both signals are off.
func setupTelemetry(getenv func(string) string, logger *slog.Logger) *telemetry {
	cfg := loadTelemetryConfig(getenv)
	for _, w := range cfg.warnings {
		logger.Warn("telemetry setting invalid", "variable", w.variable, "effect", w.effect)
	}
	var tp trace.TracerProvider
	var mp metric.MeterProvider
	var stops []func(context.Context) error
	if cfg.traces != nil || cfg.metrics != nil {
		reporter := &telemetryReporter{log: logger, now: time.Now, last: map[string]time.Time{}}
		// The SDK's default logger writes plain text to stderr, and its default error
		// handler logs raw errors, which can quote the endpoint.
		otel.SetLogger(logr.Discard())
		otel.SetErrorHandler(reporter)
		if cfg.traces != nil {
			if p, err := newTracerProvider(cfg, reporter); err != nil {
				reporter.report("traces", "other")
				cfg.traces = nil
			} else {
				tp, stops = p, append(stops, p.Shutdown)
			}
		}
		if cfg.metrics != nil {
			if p, err := newMeterProvider(cfg, reporter); err != nil {
				reporter.report("metrics", "other")
				cfg.metrics = nil
			} else {
				mp, stops = p, append(stops, p.Shutdown)
			}
		}
		reporter.ready.Store(true)
	}
	t := newInstruments(tp, mp)
	t.stops = stops
	attrs := []any{"traces", signalState(cfg.traces), "metrics", signalState(cfg.metrics)}
	if cfg.traces != nil || cfg.metrics != nil {
		attrs = append(attrs, "protocol", telemetryProtocol)
	}
	if cfg.traces != nil {
		attrs = append(attrs, "traces_endpoint", endpointOrigin(cfg.traces.endpoint))
	}
	if cfg.metrics != nil {
		attrs = append(attrs, "metrics_endpoint", endpointOrigin(cfg.metrics.endpoint))
	}
	logger.Info("telemetry configured", attrs...)
	return t
}

func signalState(s *signalSettings) string {
	if s == nil {
		return "disabled"
	}
	return "enabled"
}

// endpointOrigin returns only the scheme and host, never the user info, path or query.
func endpointOrigin(u *url.URL) string {
	return u.Scheme + "://" + u.Host
}

func newTracerProvider(cfg telemetryConfig, reporter *telemetryReporter) (*sdktrace.TracerProvider, error) {
	s := cfg.traces
	transport := newExportTransport(s)
	exp, err := otlptracehttp.New(context.Background(),
		otlptracehttp.WithEndpointURL(s.endpoint.String()),
		otlptracehttp.WithHeaders(s.headers),
		otlptracehttp.WithTimeout(s.timeout),
		otlptracehttp.WithHTTPClient(&http.Client{Transport: transport, Timeout: s.timeout}),
	)
	if err != nil {
		return nil, err
	}
	wrapped := &spanExporter{SpanExporter: exp, resource: cfg.resource, transport: transport, reporter: reporter}
	// Explicit options, so that the SDK's own OTEL_BSP_* and sampler parsing can't
	// change what was validated.
	return sdktrace.NewTracerProvider(
		sdktrace.WithSampler(cfg.sampler),
		sdktrace.WithBatcher(wrapped,
			sdktrace.WithMaxQueueSize(spanQueueSize),
			sdktrace.WithMaxExportBatchSize(spanBatchSize),
			sdktrace.WithBatchTimeout(spanBatchDelay),
			sdktrace.WithExportTimeout(spanExportTimeout)),
	), nil
}

func newMeterProvider(cfg telemetryConfig, reporter *telemetryReporter) (*sdkmetric.MeterProvider, error) {
	s := cfg.metrics
	transport := newExportTransport(s)
	exp, err := otlpmetrichttp.New(context.Background(),
		otlpmetrichttp.WithEndpointURL(s.endpoint.String()),
		otlpmetrichttp.WithHeaders(s.headers),
		otlpmetrichttp.WithTimeout(s.timeout),
		otlpmetrichttp.WithHTTPClient(&http.Client{Transport: transport, Timeout: s.timeout}),
	)
	if err != nil {
		return nil, err
	}
	wrapped := &metricExporter{Exporter: exp, resource: cfg.resource, transport: transport, reporter: reporter}
	reader := sdkmetric.NewPeriodicReader(wrapped,
		sdkmetric.WithInterval(cfg.interval), sdkmetric.WithTimeout(cfg.exportTimeout))
	return sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader)), nil
}

// spanExporter replaces each span's resource, because the SDK merges every
// OTEL_RESOURCE_ATTRIBUTES key into the provider's resource, and reports export
// failures without their text.
type spanExporter struct {
	sdktrace.SpanExporter
	resource  *resource.Resource
	transport *exportTransport
	reporter  *telemetryReporter
}

func (e *spanExporter) ExportSpans(ctx context.Context, spans []sdktrace.ReadOnlySpan) error {
	wrapped := make([]sdktrace.ReadOnlySpan, len(spans))
	for i, s := range spans {
		wrapped[i] = resourcedSpan{ReadOnlySpan: s, resource: e.resource}
	}
	e.transport.status.Store(0)
	return e.reporter.exportFailed("traces", e.transport, e.SpanExporter.ExportSpans(ctx, wrapped))
}

type resourcedSpan struct {
	sdktrace.ReadOnlySpan
	resource *resource.Resource
}

func (s resourcedSpan) Resource() *resource.Resource { return s.resource }

// metricExporter is spanExporter's counterpart for metrics.
type metricExporter struct {
	sdkmetric.Exporter
	resource  *resource.Resource
	transport *exportTransport
	reporter  *telemetryReporter
}

func (e *metricExporter) Export(ctx context.Context, rm *metricdata.ResourceMetrics) error {
	replaced := *rm
	replaced.Resource = e.resource
	e.transport.status.Store(0)
	return e.reporter.exportFailed("metrics", e.transport, e.Exporter.Export(ctx, &replaced))
}

// exportTransport notes the last HTTP status that wasn't a success, because the
// exporters return it only inside error text that also holds the endpoint.
type exportTransport struct {
	base   http.RoundTripper
	status atomic.Int32
}

func newExportTransport(s *signalSettings) *exportTransport {
	// A clone of the default transport, so that HTTPS_PROXY, NO_PROXY and
	// SSL_CERT_FILE work as they do for any Go client.
	base := http.DefaultTransport.(*http.Transport).Clone()
	if s.roots != nil {
		base.TLSClientConfig = &tls.Config{RootCAs: s.roots, MinVersion: tls.VersionTLS12}
	}
	return &exportTransport{base: base}
}

func (t *exportTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	resp, err := t.base.RoundTrip(req)
	if err == nil && (resp.StatusCode < 200 || resp.StatusCode > 299) {
		t.status.Store(int32(resp.StatusCode))
	}
	return resp, err
}

// exportFailureReason names a failure without its text, which can hold the endpoint.
func exportFailureReason(err error, status int32) string {
	var netErr net.Error
	var errno syscall.Errno
	switch {
	case status != 0:
		return "HTTP " + strconv.Itoa(int(status))
	case errors.Is(err, context.DeadlineExceeded), errors.As(err, &netErr) && netErr.Timeout():
		return "timeout"
	case errors.As(err, &errno) && (errno == syscall.ECONNREFUSED || errno == wsaECONNREFUSED):
		return "connection refused"
	}
	return "other"
}

// telemetryReporter logs telemetry failures as one bounded WARN record per signal
// per telemetryErrorInterval. It is also the OpenTelemetry error handler.
type telemetryReporter struct {
	log *slog.Logger
	now func() time.Time
	// ready drops the errors the SDK reports while the providers are built, because
	// the settings it parses then have already been validated.
	ready atomic.Bool
	mu    sync.Mutex
	last  map[string]time.Time
}

// reportedError marks an export failure the reporter has already handled, so that
// Handle doesn't report it again when the SDK passes it on.
type reportedError struct{ err error }

func (e *reportedError) Error() string { return e.err.Error() }
func (e *reportedError) Unwrap() error { return e.err }

func (r *telemetryReporter) exportFailed(signal string, transport *exportTransport, err error) error {
	if err == nil {
		return nil
	}
	r.report(signal, exportFailureReason(err, transport.status.Load()))
	return &reportedError{err}
}

func (r *telemetryReporter) report(signal, reason string) {
	r.mu.Lock()
	now := r.now()
	if last, ok := r.last[signal]; ok && now.Sub(last) < telemetryErrorInterval {
		r.mu.Unlock()
		return
	}
	r.last[signal] = now
	r.mu.Unlock()
	r.log.Warn("telemetry error", "signal", signal, "reason", reason)
}

// Handle reports an SDK error that no exporter reported, without its text. A
// cancellation comes from shutdown, which reports an incomplete flush itself.
func (r *telemetryReporter) Handle(err error) {
	if _, ok := errors.AsType[*reportedError](err); ok || errors.Is(err, context.Canceled) || !r.ready.Load() {
		return
	}
	r.report("sdk", "other")
}

// signalSettings configures one signal's OTLP/HTTP exporter.
type signalSettings struct {
	endpoint *url.URL
	headers  map[string]string
	timeout  time.Duration
	// roots replaces the system roots when a certificate file is set.
	roots *x509.CertPool
}

type telemetryWarning struct{ variable, effect string }

// telemetryConfig is the validated OTEL_* configuration. A nil signal is off.
type telemetryConfig struct {
	traces, metrics *signalSettings
	sampler         sdktrace.Sampler
	interval        time.Duration
	exportTimeout   time.Duration
	resource        *resource.Resource
	warnings        []telemetryWarning
}

// loadTelemetryConfig validates the OTEL_* settings the router supports. A signal
// is on only when it has an endpoint, and an invalid setting turns off the signals
// it applies to. Settings are checked only when there is an endpoint.
func loadTelemetryConfig(getenv func(string) string) telemetryConfig {
	p := &configParser{getenv: getenv}
	c := &p.config
	if p.value("OTEL_EXPORTER_OTLP_ENDPOINT") == "" && p.value("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") == "" &&
		p.value("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT") == "" {
		return *c
	}
	switch strings.ToLower(p.value("OTEL_SDK_DISABLED")) {
	case "true":
		return *c
	case "", "false":
	default:
		p.warn("OTEL_SDK_DISABLED", "ignored")
	}
	c.traces = p.signal("traces")
	c.metrics = p.signal("metrics")
	if c.traces != nil {
		c.sampler = p.sampler()
		if c.sampler == nil {
			c.traces = nil
		}
	}
	if c.metrics != nil {
		var ok1, ok2 bool
		c.interval, ok1 = p.milliseconds("OTEL_METRIC_EXPORT_INTERVAL", defaultMetricInterval, "metrics")
		c.exportTimeout, ok2 = p.milliseconds("OTEL_METRIC_EXPORT_TIMEOUT", defaultMetricTimeout, "metrics")
		if !ok1 || !ok2 {
			c.metrics = nil
		}
	}
	if c.traces != nil || c.metrics != nil {
		c.resource = p.resource()
	}
	return *c
}

type configParser struct {
	getenv func(string) string
	config telemetryConfig
}

func (p *configParser) value(name string) string {
	return strings.TrimSpace(p.getenv(name))
}

// warn records an invalid variable once, merging the signals it turns off.
func (p *configParser) warn(variable, effect string) {
	for i, w := range p.config.warnings {
		if w.variable == variable {
			if w.effect != effect {
				p.config.warnings[i].effect = "traces and metrics disabled"
			}
			return
		}
	}
	p.config.warnings = append(p.config.warnings, telemetryWarning{variable, effect})
}

// lookup returns the signal-specific OTLP setting when it's set, else the shared one.
func (p *configParser) lookup(signal, setting string) (string, string) {
	name := "OTEL_EXPORTER_OTLP_" + strings.ToUpper(signal) + "_" + setting
	if v := p.value(name); v != "" {
		return name, v
	}
	name = "OTEL_EXPORTER_OTLP_" + setting
	return name, p.value(name)
}

func (p *configParser) signal(signal string) *signalSettings {
	off := signal + " disabled"
	endpointVar, raw := p.lookup(signal, "ENDPOINT")
	if raw == "" {
		return nil
	}
	exporterVar := "OTEL_" + strings.ToUpper(signal) + "_EXPORTER"
	switch strings.ToLower(p.value(exporterVar)) {
	case "", "otlp":
	case "none":
		return nil
	default:
		p.warn(exporterVar, off)
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.Opaque != "" {
		p.warn(endpointVar, off)
		return nil
	}
	if endpointVar == "OTEL_EXPORTER_OTLP_ENDPOINT" {
		// The shared endpoint is a base URL, and each signal has its own path under it.
		u.Path = strings.TrimSuffix(u.Path, "/") + "/v1/" + signal
		u.RawPath = ""
	}
	if name, v := p.lookup(signal, "PROTOCOL"); v != "" && v != telemetryProtocol {
		p.warn(name, off)
		return nil
	}
	s := &signalSettings{endpoint: u}
	name, v := p.lookup(signal, "HEADERS")
	if s.headers, err = parseHeaders(v); err != nil {
		p.warn(name, off)
		return nil
	}
	var ok bool
	if s.timeout, ok = p.milliseconds(p.lookupName(signal, "TIMEOUT"), defaultExportTimeout, signal); !ok {
		return nil
	}
	if name, path := p.lookup(signal, "CERTIFICATE"); path != "" {
		data, err := os.ReadFile(path)
		s.roots = x509.NewCertPool()
		if err != nil || !s.roots.AppendCertsFromPEM(data) {
			p.warn(name, off)
			return nil
		}
	}
	return s
}

// lookupName returns the name lookup would read.
func (p *configParser) lookupName(signal, setting string) string {
	name, _ := p.lookup(signal, setting)
	return name
}

// milliseconds reads a positive whole number of milliseconds.
func (p *configParser) milliseconds(name string, fallback time.Duration, signal string) (time.Duration, bool) {
	raw := p.value(name)
	if raw == "" {
		return fallback, true
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || n <= 0 || n > math.MaxInt64/int64(time.Millisecond) {
		p.warn(name, signal+" disabled")
		return 0, false
	}
	return time.Duration(n) * time.Millisecond, true
}

// sampler returns the configured sampler, or nil after warning about an invalid one.
func (p *configParser) sampler() sdktrace.Sampler {
	ratio := func() (float64, bool) {
		raw := p.value("OTEL_TRACES_SAMPLER_ARG")
		if raw == "" {
			return 1, true
		}
		f, err := strconv.ParseFloat(raw, 64)
		if err != nil || !(f >= 0 && f <= 1) {
			p.warn("OTEL_TRACES_SAMPLER_ARG", "traces disabled")
			return 0, false
		}
		return f, true
	}
	switch strings.ToLower(p.value("OTEL_TRACES_SAMPLER")) {
	case "", "parentbased_always_on":
		return sdktrace.ParentBased(sdktrace.AlwaysSample())
	case "always_on":
		return sdktrace.AlwaysSample()
	case "always_off":
		return sdktrace.NeverSample()
	case "parentbased_always_off":
		return sdktrace.ParentBased(sdktrace.NeverSample())
	case "traceidratio":
		if r, ok := ratio(); ok {
			return sdktrace.TraceIDRatioBased(r)
		}
		return nil
	case "parentbased_traceidratio":
		if r, ok := ratio(); ok {
			return sdktrace.ParentBased(sdktrace.TraceIDRatioBased(r))
		}
		return nil
	}
	p.warn("OTEL_TRACES_SAMPLER", "traces disabled")
	return nil
}

// resource identifies the router. OTEL_RESOURCE_ATTRIBUTES may set only the
// service namespace and deployment environment, so that it can't forward arbitrary
// data or replace the router's version. The random instance id keeps the metric
// streams of concurrent routers apart.
func (p *configParser) resource() *resource.Resource {
	attrs := []attribute.KeyValue{
		semconv.ServiceName(cmp.Or(p.value("OTEL_SERVICE_NAME"), serviceName)),
		semconv.ServiceVersion(version),
		semconv.ServiceInstanceID(uuid.NewString()),
		semconv.TelemetrySDKName("opentelemetry"),
		semconv.TelemetrySDKLanguageGo,
		semconv.TelemetrySDKVersion(sdk.Version()),
	}
	if raw := p.value("OTEL_RESOURCE_ATTRIBUTES"); raw != "" {
		pairs, err := parseKeyValues(raw, func(string) bool { return true })
		if err != nil {
			p.warn("OTEL_RESOURCE_ATTRIBUTES", "ignored")
		} else {
			ignored := false
			for _, kv := range pairs {
				switch kv[0] {
				case string(semconv.ServiceNamespaceKey):
					attrs = append(attrs, semconv.ServiceNamespace(kv[1]))
				case string(semconv.DeploymentEnvironmentNameKey):
					attrs = append(attrs, semconv.DeploymentEnvironmentNameKey.String(kv[1]))
				default:
					ignored = true
				}
			}
			if ignored {
				p.warn("OTEL_RESOURCE_ATTRIBUTES", "other keys ignored")
			}
		}
	}
	return resource.NewWithAttributes(semconv.SchemaURL, attrs...)
}

var errKeyValues = errors.New("invalid key-value list")

// parseKeyValues parses a comma-separated list of key=value pairs with
// percent-encoded values, as OTEL_EXPORTER_OTLP_HEADERS and
// OTEL_RESOURCE_ATTRIBUTES use.
func parseKeyValues(raw string, validKey func(string) bool) ([][2]string, error) {
	var pairs [][2]string
	for item := range strings.SplitSeq(raw, ",") {
		if strings.TrimSpace(item) == "" {
			continue
		}
		k, v, ok := strings.Cut(item, "=")
		k = strings.TrimSpace(k)
		if !ok || k == "" || !validKey(k) {
			return nil, errKeyValues
		}
		v, err := url.PathUnescape(strings.TrimSpace(v))
		if err != nil || !validHeaderValue(v) {
			return nil, errKeyValues
		}
		pairs = append(pairs, [2]string{k, v})
	}
	return pairs, nil
}

func parseHeaders(raw string) (map[string]string, error) {
	pairs, err := parseKeyValues(raw, validHeaderName)
	if err != nil {
		return nil, err
	}
	// Never nil, so that the exporters don't read the variable themselves.
	headers := map[string]string{}
	for _, kv := range pairs {
		headers[kv[0]] = kv[1]
	}
	return headers, nil
}

// validHeaderName accepts an RFC 9110 token.
func validHeaderName(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !('a' <= c && c <= 'z' || 'A' <= c && c <= 'Z' || '0' <= c && c <= '9' || strings.IndexByte("!#$%&'*+-.^_`|~", c) >= 0) {
			return false
		}
	}
	return s != ""
}

// validHeaderValue rejects control characters other than tab.
func validHeaderValue(s string) bool {
	for i := 0; i < len(s); i++ {
		if c := s[i]; c != '\t' && (c < 0x20 || c == 0x7f) {
			return false
		}
	}
	return true
}
