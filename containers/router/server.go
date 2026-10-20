package main

import (
	"cmp"
	"context"
	"encoding/json/v2"
	"errors"
	"io"
	"log"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/propagation"
	semconv "go.opentelemetry.io/otel/semconv/v1.43.0"
	"go.opentelemetry.io/otel/trace"
)

const (
	maxBodyBytes      = 1 << 20
	maxInFlight       = 64
	headerReadTimeout = 10 * time.Second
	readTimeout       = 30 * time.Second
	writeTimeout      = 30 * time.Second
	idleTimeout       = 5 * time.Second
	drainTimeout      = 500 * time.Millisecond
)

// server is the HTTP adapter for a Service. It wraps a ServeMux with the
// in-flight limit, the body limit, panic recovery, request logging and telemetry.
type server struct {
	service *Service
	log     *slog.Logger
	tel     *telemetry
	drain   time.Duration
	mux     *http.ServeMux
	slots   chan struct{}
	// hold, which only tests set, runs before each endpoint, to hold a request open
	// or panic.
	hold func(route string)
}

// newServer returns a server with telemetry off. serve replaces tel when the
// OTEL_* settings turn it on.
func newServer(service *Service, logger *slog.Logger) *server {
	s := &server{service: service, log: logger, tel: newInstruments(nil, nil), drain: drainTimeout,
		mux: http.NewServeMux(), slots: make(chan struct{}, maxInFlight)}
	s.handle("/healthz", http.MethodGet, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	s.handle("/capabilities", http.MethodGet, func(w http.ResponseWriter, _ *http.Request) {
		sendJSON(w, s.service.Capabilities())
	})
	s.handle("/classify", http.MethodPost, func(w http.ResponseWriter, r *http.Request) {
		plan(s, w, r, planner[ClassifyRequest, ClassifyResponse]{
			operation: "classify", decode: DecodeClassifyRequest, serve: s.service.Classify, describe: describeClassify,
		})
	})
	s.handle("/route", http.MethodPost, func(w http.ResponseWriter, r *http.Request) {
		plan(s, w, r, planner[RouteRequest, RouteResponse]{
			operation: "route", decode: DecodeRouteRequest, serve: s.service.Route, describe: s.describeRoute,
		})
	})
	s.mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		sendError(w, http.StatusNotFound, CodeNotFound, "Not Found")
	})
	return s
}

// handle registers an endpoint without a method pattern, so that a wrong method,
// HEAD and OPTIONS included, gets the JSON 405 rather than ServeMux's plain one.
func (s *server) handle(route, method string, serve http.HandlerFunc) {
	s.mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != method {
			w.Header().Set("Allow", method)
			sendError(w, http.StatusMethodNotAllowed, CodeMethodNotAllowed, "Method Not Allowed")
			return
		}
		if s.hold != nil {
			s.hold(route)
		}
		serve(w, r)
	})
}

func (s *server) httpServer() *http.Server {
	protocols := new(http.Protocols)
	protocols.SetHTTP1(true)
	return &http.Server{
		Handler:           s,
		Protocols:         protocols,
		ReadHeaderTimeout: headerReadTimeout,
		ReadTimeout:       readTimeout,
		WriteTimeout:      writeTimeout,
		IdleTimeout:       idleTimeout,
		// net/http's own messages are plain text that can quote request data, and serve
		// writes only the JSON records in logging.go.
		ErrorLog: log.New(io.Discard, "", 0),
	}
}

// serveUntilSignal serves on ln until a signal arrives, then lets in-flight
// requests finish for up to s.drain, closes the rest and flushes telemetry.
func (s *server) serveUntilSignal(ln net.Listener, signals <-chan os.Signal) int {
	srv := s.httpServer()
	served := make(chan error, 1)
	go func() { served <- srv.Serve(ln) }()
	var sig os.Signal
	select {
	case err := <-served:
		s.log.Error("listen failed", "error", sanitizeDetail(err.Error()))
		s.flushTelemetry()
		return 1
	case sig = <-signals:
	}
	start := time.Now()
	s.log.Info("shutting down", "signal", signalName(sig))
	ctx, cancel := context.WithTimeout(context.Background(), s.drain)
	defer cancel()
	drained := srv.Shutdown(ctx) == nil
	if !drained {
		_ = srv.Close()
	}
	s.flushTelemetry()
	s.log.Info("stopped", "drained", drained, "duration_ms", milliseconds(time.Since(start)))
	return 0
}

func (s *server) flushTelemetry() {
	if s.tel.enabled() && !s.tel.flush() {
		s.log.Warn("telemetry flush incomplete")
	}
}

func signalName(sig os.Signal) string {
	switch sig {
	case syscall.SIGTERM:
		return "SIGTERM"
	case os.Interrupt:
		return "SIGINT"
	}
	return sig.String()
}

// exchange is one request's state for the request log and telemetry.
type exchange struct {
	rec    *recorder
	start  time.Time
	id     string
	method string
	route  string
	// ctx holds the incoming trace context, or the server span once it starts.
	ctx        context.Context
	span       trace.Span
	overloaded bool
}

// ServeHTTP applies the in-flight limit and the body limit, then routes the request.
func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	x := &exchange{rec: &recorder{ResponseWriter: w}, start: time.Now(), id: newRequestID(), method: logMethod(r.Method)}
	if _, pattern := s.mux.Handler(r); pattern != "/" {
		x.route = pattern
	}
	x.ctx = traceContext.Extract(r.Context(), propagation.HeaderCarrier(r.Header))
	defer s.finish(x)
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	default:
		// A bare 503, which openapi.yaml documents.
		x.overloaded = true
		x.rec.Header().Set("Content-Type", "text/plain; charset=utf-8")
		x.rec.Header().Set("Connection", "close")
		x.rec.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(x.rec, "Service Unavailable")
		return
	}
	if s.tel.tracer != nil && (x.route != "/healthz" || r.Method != http.MethodGet) {
		s.startSpan(x, r)
	}
	r = r.WithContext(x.ctx)
	if r.ContentLength > maxBodyBytes {
		sendTooLarge(x.rec)
		return
	}
	// MaxBytesReader gets the original writer, so that net/http closes the
	// connection after a body over the limit.
	r.Body = &countingBody{ReadCloser: http.MaxBytesReader(w, r.Body, maxBodyBytes), rec: x.rec}
	s.mux.ServeHTTP(x.rec, r)
}

// startSpan starts the server span with the allowlisted request attributes.
func (s *server) startSpan(x *exchange, r *http.Request) {
	name := x.method
	attrs := []attribute.KeyValue{semconv.HTTPRequestMethodKey.String(x.method)}
	if x.route != "" {
		name += " " + x.route
		attrs = append(attrs, semconv.HTTPRouteKey.String(x.route))
	}
	scheme, protocol := "http", "1.1"
	if r.TLS != nil {
		scheme = "https"
	}
	if r.ProtoMajor == 1 && r.ProtoMinor == 0 {
		protocol = "1.0"
	}
	attrs = append(attrs, semconv.URLSchemeKey.String(scheme), semconv.NetworkProtocolVersionKey.String(protocol))
	x.ctx, x.span = s.tel.tracer.Start(x.ctx, name, trace.WithSpanKind(trace.SpanKindServer), trace.WithAttributes(attrs...))
}

// finish recovers a panic, records the request's telemetry and logs it. It must be
// deferred directly.
func (s *server) finish(x *exchange) {
	rec := x.rec
	if p := recover(); p != nil {
		if p == http.ErrAbortHandler {
			// The body never arrived, so there is no status to record or log.
			s.endRequest(x, requestAborted)
			panic(p)
		}
		s.log.Error("panic", "request_id", x.id, "route", logRoute(x.route), "stack", panicStack())
		if rec.status != 0 {
			// The response already started, so close the connection.
			s.endRequest(x, string(CodeInternalError))
			panic(http.ErrAbortHandler)
		}
		sendError(rec, http.StatusInternalServerError, CodeInternalError, "internal error while processing the request")
	}
	s.endRequest(x, "")
	status := cmp.Or(rec.status, http.StatusOK)
	if x.route == "/healthz" && status == http.StatusNoContent {
		return
	}
	level := slog.LevelInfo
	if status >= http.StatusInternalServerError {
		level = slog.LevelError
	}
	attrs := []slog.Attr{
		slog.String("request_id", x.id),
		slog.String("method", x.method),
		slog.String("route", logRoute(x.route)),
		slog.Int("status", status),
		slog.Float64("duration_ms", milliseconds(time.Since(x.start))),
	}
	if rec.code != "" {
		attrs = append(attrs, slog.String("error_code", string(rec.code)))
	}
	attrs = append(attrs, slog.Int("request_bytes", rec.received), slog.Int("response_bytes", rec.written))
	// TraceContext accepts only a valid, nonzero trace id. Without a router span, the
	// context's span id is the caller's, so it isn't logged.
	if sc := trace.SpanContextFromContext(x.ctx); sc.IsValid() {
		attrs = append(attrs, slog.String("trace_id", sc.TraceID().String()))
		if x.span != nil {
			attrs = append(attrs, slog.String("span_id", sc.SpanID().String()))
		}
	}
	s.log.LogAttrs(context.Background(), level, "request", attrs...)
}

// endRequest records the request duration and any rejection, and ends the server
// span. aborted is the error.type of a request that ended without a response.
func (s *server) endRequest(x *exchange, aborted string) {
	attrs := []attribute.KeyValue{semconv.HTTPRequestMethodKey.String(x.method)}
	if x.route != "" {
		attrs = append(attrs, semconv.HTTPRouteKey.String(x.route))
	}
	var result []attribute.KeyValue
	status, errorType := cmp.Or(x.rec.status, http.StatusOK), aborted
	if aborted == "" {
		result = append(result, semconv.HTTPResponseStatusCodeKey.Int(status))
		if status >= http.StatusBadRequest {
			// Only the bare 503 has no error code.
			errorType = cmp.Or(string(x.rec.code), strconv.Itoa(status))
		}
	}
	if errorType != "" {
		result = append(result, semconv.ErrorTypeKey.String(errorType))
	}
	s.tel.duration.Record(x.ctx, time.Since(x.start).Seconds(), metric.WithAttributes(append(attrs, result...)...))
	switch {
	case x.overloaded:
		s.tel.rejected.Add(x.ctx, 1, metric.WithAttributes(attrReason.String("overload")))
	case x.rec.code == CodePayloadTooLarge:
		s.tel.rejected.Add(x.ctx, 1, metric.WithAttributes(attrReason.String("payload_too_large")))
	}
	if x.span != nil {
		x.span.SetAttributes(result...)
		if aborted != "" || status >= http.StatusInternalServerError {
			x.span.SetStatus(codes.Error, "")
		}
		x.span.End()
	}
}

// planner is one planning endpoint. describe returns the operation's span
// attributes and its extra metric attributes; resp is nil unless the outcome is ok.
type planner[Req, Resp any] struct {
	operation string
	decode    func([]byte) (*Req, error)
	serve     func(*Req) (*Resp, error)
	describe  func(req *Req, resp *Resp) (spanAttrs, metricAttrs []attribute.KeyValue)
}

// plan reads, checks and decodes a planning request, then serves it. A decoded
// request gets a child span and a planning outcome.
func plan[Req, Resp any](s *server, w http.ResponseWriter, r *http.Request, p planner[Req, Resp]) {
	body, err := io.ReadAll(r.Body)
	if _, ok := errors.AsType[*http.MaxBytesError](err); ok {
		sendTooLarge(w)
		return
	}
	if err != nil {
		// The client sent a broken or incomplete body, or timed out.
		panic(http.ErrAbortHandler)
	}
	if !isJSONMediaType(r.Header.Get("Content-Type")) {
		sendError(w, http.StatusUnsupportedMediaType, CodeUnsupportedMediaType, "Expected a JSON request body")
		return
	}
	req, err := p.decode(body)
	if err != nil {
		sendPlanningError(w, err)
		return
	}
	ctx, span := r.Context(), trace.Span(nil)
	if s.tel.tracer != nil {
		ctx, span = s.tel.tracer.Start(ctx, "gh_aw_router."+p.operation, trace.WithSpanKind(trace.SpanKindInternal))
	}
	// A panic in serve or in encoding leaves the outcome as internal_error.
	outcome, resp := outcomeInternalError, (*Resp)(nil)
	defer func() {
		if outcome != outcomeOK {
			resp = nil
		}
		spanAttrs, metricAttrs := p.describe(req, resp)
		metricAttrs = append(metricAttrs, attrOperation.String(p.operation), attrOutcome.String(outcome))
		s.tel.outcomes.Add(ctx, 1, metric.WithAttributes(metricAttrs...))
		if span != nil {
			span.SetAttributes(append(spanAttrs, attrOutcome.String(outcome))...)
			if outcome == outcomeInternalError {
				span.SetStatus(codes.Error, "")
			}
			span.End()
		}
	}()
	if resp, err = p.serve(req); err != nil {
		switch KindOf(err) {
		case NoRoute:
			outcome = outcomeNoRoute
		case Malformed, Invalid, BadRequest:
			outcome = outcomeInvalidRequest
		}
		sendPlanningError(w, err)
		return
	}
	sendJSON(w, resp)
	outcome = outcomeOK
}

func describeClassify(req *ClassifyRequest, resp *ClassifyResponse) (spanAttrs, _ []attribute.KeyValue) {
	spanAttrs = []attribute.KeyValue{attrMessages.Int(len(req.Conversation)), attrModels.Int(len(req.Models))}
	if resp != nil {
		spanAttrs = append(spanAttrs, attrPriorTurns.Int(min(len(authoredMessages(req.Conversation))-1, maxPriorTurns)))
	}
	return spanAttrs, nil
}

// describeRoute records the selected model only from the loaded catalogue, never
// from the request.
func (s *server) describeRoute(req *RouteRequest, resp *RouteResponse) (spanAttrs, metricAttrs []attribute.KeyValue) {
	metricAttrs = []attribute.KeyValue{
		attrGoal.String(string(req.Objective.Goal)),
		attrMode.String(string(req.Objective.Mode)),
		attrResolvedMode.String(string(resolvedProfile(req).Mode)),
	}
	spanAttrs = append([]attribute.KeyValue{
		attrMessages.Int(len(req.Conversation)),
		attrModels.Int(len(req.Models)),
		attrClassificationPresent.Bool(req.Classification != nil),
	}, metricAttrs...)
	if c := req.Classification; c != nil {
		spanAttrs = append(spanAttrs,
			attrTaskType.String(string(c.Labels.TaskType)),
			attrScope.String(string(c.Labels.Scope)),
			attrTaskComplexity.String(string(c.Labels.TaskComplexity)),
			attrModeRecommendation.String(string(c.Mode)))
	}
	if resp != nil && len(resp.RankedChoices) > 0 {
		if pair, ok := s.service.cataloguePair(resp.RankedChoices[0].Pair()); ok {
			spanAttrs = append(spanAttrs, attrSelectedModel.String(pair.Model))
			if pair.Effort != "" {
				spanAttrs = append(spanAttrs, attrSelectedEffort.String(string(pair.Effort)))
			}
		}
	}
	return spanAttrs, metricAttrs
}

// sendPlanningError answers a request failure. Any other error is a bug.
func sendPlanningError(w http.ResponseWriter, err error) {
	re, ok := errors.AsType[*Error](err)
	if !ok {
		panic("unexpected planning error")
	}
	status, code := re.HTTP()
	var detail string
	switch re.Kind {
	case Malformed:
		// The parser's message can quote the body.
		detail = "Failed to parse the request body as JSON"
	case Invalid:
		detail = "request does not match the contract: " + re.Detail
	case NoRoute:
		detail = "no route: " + re.Detail
	default:
		detail = "invalid request: " + re.Detail
	}
	sendError(w, status, code, detail)
}

// isJSONMediaType accepts a missing content type, application/json and
// application/*+json, with any parameters.
func isJSONMediaType(value string) bool {
	if value == "" {
		return true
	}
	mediaType, _, err := mime.ParseMediaType(value)
	if err != nil && !errors.Is(err, mime.ErrInvalidMediaParameter) {
		return false
	}
	minor, ok := strings.CutPrefix(mediaType, "application/")
	return ok && (minor == "json" || strings.HasSuffix(minor, "+json"))
}

func sendTooLarge(w http.ResponseWriter) {
	// The rest of the body is never read, so the connection can't be reused.
	w.Header().Set("Connection", "close")
	sendError(w, http.StatusRequestEntityTooLarge, CodePayloadTooLarge,
		"request body exceeds the "+strconv.Itoa(maxBodyBytes)+"-byte limit")
}

func sendJSON(w http.ResponseWriter, v any) {
	data, err := json.Marshal(v)
	if err != nil {
		panic("response encoding failed")
	}
	send(w, http.StatusOK, data)
}

func sendError(w http.ResponseWriter, status int, code ErrorCode, detail string) {
	if rec, ok := w.(*recorder); ok {
		rec.code = code
	}
	data, err := json.Marshal(ErrorResponse{Code: code, Detail: sanitizeDetail(detail)})
	if err != nil {
		panic("error encoding failed")
	}
	send(w, status, data)
}

func send(w http.ResponseWriter, status int, body []byte) {
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// recorder notes what the request log needs: the status, the error code and the
// bytes read and written.
type recorder struct {
	http.ResponseWriter
	status   int
	code     ErrorCode
	written  int
	received int
}

func (r *recorder) WriteHeader(status int) {
	if r.status == 0 {
		r.status = status
	}
	r.ResponseWriter.WriteHeader(status)
}

func (r *recorder) Write(b []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	n, err := r.ResponseWriter.Write(b)
	r.written += n
	return n, err
}

type countingBody struct {
	io.ReadCloser
	rec *recorder
}

func (b *countingBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	b.rec.received += n
	return n, err
}
