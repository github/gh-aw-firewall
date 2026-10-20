package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"runtime"
	"strings"
	"time"
	"unicode"
)

const (
	serviceName = "gh-aw-router"
	// maxDetailChars bounds error details, in code points.
	maxDetailChars = 500
	timeFormat     = "2006-01-02T15:04:05.000Z07:00"
)

// logLevels maps the serve --log-level values, which are Uvicorn's, to slog levels.
var logLevels = map[string]slog.Level{
	"critical": slog.LevelError,
	"error":    slog.LevelError,
	"warning":  slog.LevelWarn,
	"info":     slog.LevelInfo,
	"debug":    slog.LevelDebug,
	"trace":    slog.LevelDebug,
}

// newLogger writes one JSON object per record. Every record names the service and
// release, and its time is UTC with millisecond precision.
func newLogger(w io.Writer, level slog.Level) *slog.Logger {
	handler := slog.NewJSONHandler(w, &slog.HandlerOptions{
		Level: level,
		ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
			if len(groups) == 0 && a.Key == slog.TimeKey {
				return slog.String(slog.TimeKey, a.Value.Time().UTC().Format(timeFormat))
			}
			return a
		},
	})
	return slog.New(handler).With("service", serviceName, "version", version)
}

// standardMethods are logged as sent. Any other method is logged as _OTHER, so that
// callers can't put arbitrary text in the logs.
var standardMethods = map[string]bool{
	"GET": true, "HEAD": true, "POST": true, "PUT": true, "PATCH": true,
	"DELETE": true, "OPTIONS": true, "CONNECT": true, "TRACE": true,
}

func logMethod(method string) string {
	if standardMethods[method] {
		return method
	}
	return "_OTHER"
}

func logRoute(route string) string {
	if route == "" {
		return "unmatched"
	}
	return route
}

// newRequestID returns a random 128-bit hex identifier for one request's log records.
func newRequestID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func milliseconds(d time.Duration) float64 {
	return float64(d.Microseconds()) / 1000
}

// sanitizeDetail replaces characters that aren't printable with spaces and keeps
// at most maxDetailChars code points, so that a detail is one bounded line.
func sanitizeDetail(s string) string {
	var b strings.Builder
	n := 0
	for _, r := range s {
		if n == maxDetailChars {
			break
		}
		if !unicode.IsPrint(r) {
			r = ' '
		}
		b.WriteRune(r)
		n++
	}
	return b.String()
}

// panicStack lists the functions and source lines of the panicking goroutine. It
// leaves out the argument words runtime/debug.Stack prints, which can hold request data.
func panicStack() string {
	pcs := make([]uintptr, 64)
	frames := runtime.CallersFrames(pcs[:runtime.Callers(3, pcs)])
	var b strings.Builder
	for {
		frame, more := frames.Next()
		fmt.Fprintf(&b, "%s\n\t%s:%d\n", frame.Function, frame.File, frame.Line)
		if !more {
			return b.String()
		}
	}
}
