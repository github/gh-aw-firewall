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
// in-flight limit, the body limit, panic recovery and request logging.
type server struct {
	service *Service
	log     *slog.Logger
	mux     *http.ServeMux
	slots   chan struct{}
	// hold, which only tests set, runs before each endpoint, to hold a request open
	// or panic.
	hold func(route string)
}

func newServer(service *Service, logger *slog.Logger) *server {
	s := &server{service: service, log: logger, mux: http.NewServeMux(), slots: make(chan struct{}, maxInFlight)}
	s.handle("/healthz", http.MethodGet, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	s.handle("/capabilities", http.MethodGet, func(w http.ResponseWriter, _ *http.Request) {
		sendJSON(w, s.service.Capabilities())
	})
	s.handle("/classify", http.MethodPost, func(w http.ResponseWriter, r *http.Request) {
		plan(w, r, DecodeClassifyRequest, s.service.Classify)
	})
	s.handle("/route", http.MethodPost, func(w http.ResponseWriter, r *http.Request) {
		plan(w, r, DecodeRouteRequest, s.service.Route)
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
// requests finish for up to drainTimeout and closes the rest.
func (s *server) serveUntilSignal(ln net.Listener, signals <-chan os.Signal) int {
	srv := s.httpServer()
	served := make(chan error, 1)
	go func() { served <- srv.Serve(ln) }()
	var sig os.Signal
	select {
	case err := <-served:
		s.log.Error("listen failed", "error", sanitizeDetail(err.Error()))
		return 1
	case sig = <-signals:
	}
	start := time.Now()
	s.log.Info("shutting down", "signal", signalName(sig))
	ctx, cancel := context.WithTimeout(context.Background(), drainTimeout)
	defer cancel()
	drained := srv.Shutdown(ctx) == nil
	if !drained {
		_ = srv.Close()
	}
	s.log.Info("stopped", "drained", drained, "duration_ms", milliseconds(time.Since(start)))
	return 0
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

// ServeHTTP applies the in-flight limit and the body limit, then routes the request.
func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start, id := time.Now(), newRequestID()
	_, pattern := s.mux.Handler(r)
	route := ""
	if pattern != "/" {
		route = pattern
	}
	rec := &recorder{ResponseWriter: w}
	defer s.finish(rec, r, route, id, start)
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	default:
		// Uvicorn's bare 503, which openapi.yaml documents.
		rec.Header().Set("Content-Type", "text/plain; charset=utf-8")
		rec.Header().Set("Connection", "close")
		rec.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(rec, "Service Unavailable")
		return
	}
	if r.ContentLength > maxBodyBytes {
		sendTooLarge(rec)
		return
	}
	// MaxBytesReader gets the original writer, so that net/http closes the
	// connection after a body over the limit.
	r.Body = &countingBody{ReadCloser: http.MaxBytesReader(w, r.Body, maxBodyBytes), rec: rec}
	s.mux.ServeHTTP(rec, r)
}

// finish recovers a panic and logs the request. It must be deferred directly.
func (s *server) finish(rec *recorder, r *http.Request, route, id string, start time.Time) {
	if p := recover(); p != nil {
		if p == http.ErrAbortHandler {
			panic(p)
		}
		s.log.Error("panic", "request_id", id, "route", logRoute(route), "stack", panicStack())
		if rec.status != 0 {
			// The response already started, so close the connection.
			panic(http.ErrAbortHandler)
		}
		sendError(rec, http.StatusInternalServerError, CodeInternalError, "internal error while processing the request")
	}
	status := cmp.Or(rec.status, http.StatusOK)
	if route == "/healthz" && status == http.StatusNoContent {
		return
	}
	level := slog.LevelInfo
	if status >= http.StatusInternalServerError {
		level = slog.LevelError
	}
	attrs := []slog.Attr{
		slog.String("request_id", id),
		slog.String("method", logMethod(r.Method)),
		slog.String("route", logRoute(route)),
		slog.Int("status", status),
		slog.Float64("duration_ms", milliseconds(time.Since(start))),
	}
	if rec.code != "" {
		attrs = append(attrs, slog.String("error_code", string(rec.code)))
	}
	attrs = append(attrs, slog.Int("request_bytes", rec.received), slog.Int("response_bytes", rec.written))
	s.log.LogAttrs(context.Background(), level, "request", attrs...)
}

// plan reads, checks and decodes a planning request, then serves it.
func plan[Req, Resp any](w http.ResponseWriter, r *http.Request,
	decode func([]byte) (*Req, error), serve func(*Req) (*Resp, error)) {
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
	req, err := decode(body)
	if err == nil {
		var resp *Resp
		if resp, err = serve(req); err == nil {
			sendJSON(w, resp)
			return
		}
	}
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
