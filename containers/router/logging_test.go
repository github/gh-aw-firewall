package main

import (
	"log/slog"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestLoggerWritesJSONRecords(t *testing.T) {
	for level, wantDebug := range map[string]bool{"trace": true, "debug": true, "info": false} {
		logs := &logBuffer{}
		logger := newLogger(logs, logLevels[level])
		logger.Debug("listening", "address", "debug")
		logger.Info("listening", "address", "127.0.0.1:8737")
		records := logs.records(t)
		if len(records) != map[bool]int{true: 2, false: 1}[wantDebug] {
			t.Errorf("%s: %s", level, logs.String())
		}
		last := records[len(records)-1]
		if last["level"] != "INFO" || last["address"] != "127.0.0.1:8737" {
			t.Errorf("%s: %v", level, last)
		}
	}
	if logLevels["critical"] != slog.LevelError || logLevels["error"] != slog.LevelError || logLevels["warning"] != slog.LevelWarn {
		t.Errorf("levels %v", logLevels)
	}
}

func TestLoggedMethodsAndRoutes(t *testing.T) {
	for method, want := range map[string]string{
		"GET": "GET", "HEAD": "HEAD", "POST": "POST", "PATCH": "PATCH", "TRACE": "TRACE",
		"get": "_OTHER", "BREW": "_OTHER", "PROPFIND": "_OTHER",
	} {
		if got := logMethod(method); got != want {
			t.Errorf("%s: %s", method, got)
		}
	}
	if logRoute("") != "unmatched" || logRoute("/route") != "/route" {
		t.Error("routes")
	}
}

func TestRequestIDsAreRandom(t *testing.T) {
	seen := map[string]bool{}
	for range 100 {
		id := newRequestID()
		if !requestID.MatchString(id) || seen[id] {
			t.Fatalf("id %q", id)
		}
		seen[id] = true
	}
}

func TestSanitizeDetail(t *testing.T) {
	for in, want := range map[string]string{
		"plain":                    "plain",
		"a\nb\tc\x00d\u2028e\x7ff": "a b c d e f",
		"修复 é":                     "修复 é",
		"\u200bzero width":         " zero width",
	} {
		if got := sanitizeDetail(in); got != want {
			t.Errorf("%q: %q", in, got)
		}
	}
	long := sanitizeDetail(strings.Repeat("é", 2*maxDetailChars))
	if utf8.RuneCountInString(long) != maxDetailChars || !utf8.ValidString(long) {
		t.Errorf("long detail has %d characters", utf8.RuneCountInString(long))
	}
}

func TestPanicStackHasNoArguments(t *testing.T) {
	var stack string
	func() {
		defer func() {
			_ = recover()
			stack = panicStack()
		}()
		panic("c4n4ry")
	}()
	if !strings.Contains(stack, "TestPanicStackHasNoArguments") || !strings.Contains(stack, "logging_test.go:") ||
		strings.Contains(stack, "c4n4ry") || strings.Contains(stack, "(0x") {
		t.Errorf("stack:\n%s", stack)
	}
}
