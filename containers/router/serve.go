package main

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const healthcheckTimeout = time.Second

var (
	errBindSyntax = errors.New("bind must use HOST:PORT syntax")
	errBindRange  = errors.New("bind must contain a host and port from 1 through 65535")
)

// Test hooks. beforeListen runs with the resolved settings just before serve
// listens, and serve exits 0 without listening when it returns true. testHold
// becomes the server's hold.
var (
	beforeListen func(host string, port int, level slog.Level) bool
	testHold     func(route string)
)

// serve loads the tables, listens and serves until a signal arrives. It writes only
// JSON log records to stderr. It exits 2 for invalid tables or bind address, 1 if
// it can't listen, and 0 after a shutdown.
func serve(cmd *command, stderr io.Writer, signals <-chan os.Signal) int {
	level := logLevels[cmd.logLevel]
	logger := newLogger(stderr, level)
	logger.Info("starting", "bind", cmd.bind, "log_level", cmd.logLevel, "go_version", runtime.Version())
	service, err := LoadService(cmd.tables)
	if err != nil {
		logger.Error("routing tables invalid", "error_code", "invalid_model_data", "error", sanitizeDetail(err.Error()))
		return 2
	}
	summary := validateData(service)
	logger.Info("routing tables loaded", "tables_path", cmd.tables, "profiles", summary.Profiles,
		"models", summary.Models, "label_cells", summary.LabelCells)
	host, port, err := parseBind(cmd.bind)
	if err != nil {
		logger.Error("configuration invalid", "error_code", string(CodeInvalidRequest), "error", err.Error())
		return 2
	}
	if beforeListen != nil && beforeListen(host, port, level) {
		return 0
	}
	ln, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		logger.Error("listen failed", "error", sanitizeDetail(err.Error()))
		return 1
	}
	logger.Info("listening", "address", ln.Addr().String())
	s := newServer(service, logger)
	s.hold = testHold
	return s.serveUntilSignal(ln, signals)
}

// parseBind splits HOST:PORT at the last colon. The port must be ASCII digits
// from 1 through 65535.
func parseBind(value string) (string, int, error) {
	i := strings.LastIndexByte(value, ':')
	if i < 0 {
		return "", 0, errBindSyntax
	}
	host, digits := value[:i], value[i+1:]
	if digits == "" || strings.Trim(digits, "0123456789") != "" {
		return "", 0, errBindSyntax
	}
	port, err := strconv.Atoi(digits)
	if host == "" || err != nil || port < 1 || port > 65535 {
		return "", 0, errBindRange
	}
	return host, port, nil
}

// healthcheck exits 0 only when url answers 204. It writes nothing to stdout and
// at most one line to stderr, never uses a proxy and never follows a redirect.
func healthcheck(url string, stderr io.Writer) int {
	client := &http.Client{
		Timeout:   healthcheckTimeout,
		Transport: &http.Transport{Proxy: nil, DisableKeepAlives: true},
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	resp, err := client.Get(url)
	if err != nil {
		fmt.Fprintf(stderr, "healthcheck failed: %s\n", sanitizeDetail(err.Error()))
		return 1
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxBodyBytes))
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		fmt.Fprintf(stderr, "healthcheck failed: HTTP %d\n", resp.StatusCode)
		return 1
	}
	return 0
}
