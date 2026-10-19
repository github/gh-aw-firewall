package main

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// holding returns a hold that keeps /capabilities requests open for d.
func holding(d time.Duration) func(string) {
	return func(route string) {
		if route == "/capabilities" {
			time.Sleep(d)
		}
	}
}

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

func eventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

type resolvedServe struct {
	host  string
	port  int
	level slog.Level
}

// resolveServe runs serve up to the point where it would listen.
func resolveServe(t *testing.T, env map[string]string, args ...string) (resolvedServe, cliResult) {
	t.Helper()
	var got resolvedServe
	beforeListen = func(host string, port int, level slog.Level) bool {
		got = resolvedServe{host, port, level}
		return true
	}
	t.Cleanup(func() { beforeListen = nil })
	r := runCLI(t, env, "", append([]string{"--routing-tables", bundledTables(t), "serve"}, args...)...)
	return got, r
}

func TestServeOptions(t *testing.T) {
	for _, c := range []struct {
		name string
		env  map[string]string
		args []string
		want resolvedServe
	}{
		{"defaults", nil, nil, resolvedServe{"127.0.0.1", 8737, slog.LevelInfo}},
		{"empty environment", map[string]string{bindEnv: "", logLevelEnv: ""}, nil, resolvedServe{"127.0.0.1", 8737, slog.LevelInfo}},
		{"environment", map[string]string{bindEnv: "localhost:9000", logLevelEnv: "debug"}, nil, resolvedServe{"localhost", 9000, slog.LevelDebug}},
		{"options over environment", map[string]string{bindEnv: "localhost:9000", logLevelEnv: "debug"},
			[]string{"--bind", "0.0.0.0:8737", "--log-level", "warning"}, resolvedServe{"0.0.0.0", 8737, slog.LevelWarn}},
		{"lowest port", nil, []string{"--bind", "127.0.0.1:1"}, resolvedServe{"127.0.0.1", 1, slog.LevelInfo}},
		{"IPv6 host", nil, []string{"--bind", "::1:65535"}, resolvedServe{"::1", 65535, slog.LevelInfo}},
		{"trace", nil, []string{"--log-level", "trace"}, resolvedServe{"127.0.0.1", 8737, slog.LevelDebug}},
		{"critical", nil, []string{"--log-level", "critical"}, resolvedServe{"127.0.0.1", 8737, slog.LevelError}},
		{"error", map[string]string{logLevelEnv: "error"}, nil, resolvedServe{"127.0.0.1", 8737, slog.LevelError}},
		// An option overrides the environment, which then isn't checked.
		{"option over an invalid environment", map[string]string{logLevelEnv: "verbose"},
			[]string{"--log-level", "info"}, resolvedServe{"127.0.0.1", 8737, slog.LevelInfo}},
	} {
		t.Run(c.name, func(t *testing.T) {
			got, r := resolveServe(t, c.env, c.args...)
			if r.code != 0 || r.stdout != "" || got != c.want {
				t.Errorf("got %+v, %+v; want %+v", got, r, c.want)
			}
			if c.want.level <= slog.LevelInfo {
				records := parseLogRecords(t, r.stderr)
				if len(records) != 2 || records[0]["msg"] != "starting" || records[1]["msg"] != "routing tables loaded" ||
					records[1]["label_cells"] != float64(210) || records[1]["models"] != float64(36) {
					t.Errorf("records %s", r.stderr)
				}
			}
		})
	}
}

// wantStartupError checks that serve wrote only JSON records and that one ERROR
// record reports the failure.
func wantStartupError(t *testing.T, r cliResult, code int, msg, errorCode, errorText string) {
	t.Helper()
	if r.code != code || r.stdout != "" {
		t.Fatalf("got %+v; want exit %d", r, code)
	}
	var errs []logRecord
	for _, rec := range parseLogRecords(t, r.stderr) {
		if rec["level"] == "ERROR" {
			errs = append(errs, rec)
		}
	}
	if len(errs) != 1 || errs[0]["msg"] != msg || (errorCode != "" && errs[0]["error_code"] != errorCode) ||
		!strings.Contains(errs[0]["error"].(string), errorText) {
		t.Errorf("error records %v; want %s %s %q", errs, msg, errorCode, errorText)
	}
}

func TestServeRejectsInvalidBindAddresses(t *testing.T) {
	for _, c := range []struct {
		bind string
		err  error
	}{
		{"localhost", errBindSyntax},
		{"localhost:", errBindSyntax},
		{"localhost:not-a-port", errBindSyntax},
		{"localhost:-1", errBindSyntax},
		// Python's int() accepts these; the fixture README records the stricter ports.
		{"localhost:+80", errBindSyntax},
		{"localhost:8_737", errBindSyntax},
		{"localhost: 8737", errBindSyntax},
		{"localhost:8737 ", errBindSyntax},
		{"localhost:٨٧٣٧", errBindSyntax},
		{":8737", errBindRange},
		{"localhost:0", errBindRange},
		{"localhost:65536", errBindRange},
		{"localhost:99999999999999999999", errBindRange},
	} {
		t.Run(c.bind, func(t *testing.T) {
			if _, _, err := parseBind(c.bind); !errors.Is(err, c.err) {
				t.Errorf("parseBind: %v", err)
			}
			for name, r := range map[string]cliResult{
				"option":      runCLI(t, nil, "", "--routing-tables", bundledTables(t), "serve", "--bind", c.bind),
				"environment": runCLI(t, map[string]string{bindEnv: c.bind}, "", "--routing-tables", bundledTables(t), "serve"),
			} {
				t.Run(name, func(t *testing.T) {
					wantStartupError(t, r, 2, "configuration invalid", "invalid_request", c.err.Error())
				})
			}
		})
	}
}

func TestServeUsageErrors(t *testing.T) {
	tables := bundledTables(t)
	for _, c := range []struct {
		name string
		env  map[string]string
		args []string
	}{
		{"invalid log level option", nil, []string{"serve", "--log-level", "verbose"}},
		{"upper-case log level", nil, []string{"serve", "--log-level", "INFO"}},
		{"invalid log level environment", map[string]string{logLevelEnv: "verbose"}, []string{"serve"}},
		{"missing value", nil, []string{"serve", "--bind"}},
		{"unknown option", nil, []string{"serve", "--port", "1"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			r := runCLI(t, c.env, "", append([]string{"--routing-tables", tables}, c.args...)...)
			if r.code != 2 || r.stdout != "" || !strings.HasPrefix(r.stderr, "usage: gh-aw-router ") {
				t.Errorf("got %+v", r)
			}
		})
	}
}

func TestServeStartupFailures(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "missing.json")
	wantStartupError(t, runCLI(t, nil, "", "--routing-tables", missing, "serve"), 2,
		"routing tables invalid", "invalid_model_data", "")
	invalid := filepath.Join(t.TempDir(), "routing.json")
	if err := os.WriteFile(invalid, []byte(`{"schema_version":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	r := runCLI(t, map[string]string{tablesEnv: invalid}, "", "serve")
	wantStartupError(t, r, 2, "routing tables invalid", "invalid_model_data", "")
	// Invalid tables fail before the bind address is checked, as in Python.
	r = runCLI(t, nil, "", "--routing-tables", missing, "serve", "--bind", "nonsense")
	wantStartupError(t, r, 2, "routing tables invalid", "invalid_model_data", "")

	busy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer busy.Close()
	r = runCLI(t, nil, "", "--routing-tables", bundledTables(t), "serve", "--bind", busy.Addr().String())
	wantStartupError(t, r, 1, "listen failed", "", "")
}

// served is a running serve command.
type served struct {
	addr   string
	stop   func()
	wait   func() (int, time.Duration)
	stderr *logBuffer
}

func startInProcess(t *testing.T, hold time.Duration) *served {
	t.Helper()
	testHold = holding(hold)
	t.Cleanup(func() { testHold = nil })
	addr := "127.0.0.1:" + strconv.Itoa(freePort(t))
	cmd, err := parseArgs([]string{"--routing-tables", bundledTables(t), "serve", "--bind", addr}, func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	logs, signals, exit := &logBuffer{}, make(chan os.Signal, 1), make(chan int, 1)
	go func() { exit <- serve(cmd, logs, signals) }()
	var stopped time.Time
	return &served{
		addr:   addr,
		stop:   func() { stopped = time.Now(); signals <- os.Interrupt },
		stderr: logs,
		wait: func() (int, time.Duration) {
			select {
			case code := <-exit:
				return code, time.Since(stopped)
			case <-time.After(10 * time.Second):
				t.Fatal("serve doesn't stop")
				return 0, 0
			}
		},
	}
}

func startProcess(t *testing.T, hold time.Duration) *served {
	t.Helper()
	addr := "127.0.0.1:" + strconv.Itoa(freePort(t))
	cmd := exec.Command(os.Args[0], "--routing-tables", bundledTables(t), "serve", "--bind", addr)
	// Race-enabled binaries sleep a second at exit by default, which the timing check would count.
	cmd.Env = append(os.Environ(), "GH_AW_ROUTER_TEST_MAIN=1", "GH_AW_ROUTER_TEST_HOLD="+hold.String(),
		"GORACE="+strings.TrimSpace(os.Getenv("GORACE")+" atexit_sleep_ms=0"))
	logs := &logBuffer{}
	cmd.Stdout, cmd.Stderr = logs, logs
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	exit := make(chan error, 1)
	var stopped time.Time
	return &served{
		addr:   addr,
		stderr: logs,
		stop: func() {
			stopped = time.Now()
			if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
				t.Fatal(err)
			}
			go func() { exit <- cmd.Wait() }()
		},
		wait: func() (int, time.Duration) {
			select {
			case err := <-exit:
				elapsed := time.Since(stopped)
				var exitErr *exec.ExitError
				if errors.As(err, &exitErr) {
					return exitErr.ExitCode(), elapsed
				}
				if err != nil {
					t.Fatal(err)
				}
				return 0, elapsed
			case <-time.After(10 * time.Second):
				t.Fatal("the process doesn't stop")
				return 0, 0
			}
		},
	}
}

// testShutdown starts serve, begins a held request, signals and checks that serve
// drains or aborts the request and exits 0 within a second.
func testShutdown(t *testing.T, start func(*testing.T, time.Duration) *served, signal string) {
	for _, c := range []struct {
		name    string
		hold    time.Duration
		drained bool
	}{
		{"drains a short request", 200 * time.Millisecond, true},
		{"aborts a long request", 3 * time.Second, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			s := start(t, c.hold)
			eventually(t, "listening", func() bool { return strings.Contains(s.stderr.String(), `"msg":"listening"`) })
			client := &http.Client{Transport: &http.Transport{Proxy: nil}}
			result := make(chan error, 1)
			go func() {
				resp, err := client.Get("http://" + s.addr + "/capabilities")
				if err == nil {
					_, err = io.ReadAll(resp.Body)
					_ = resp.Body.Close()
					if err == nil && resp.StatusCode != 200 {
						err = fmt.Errorf("status %d", resp.StatusCode)
					}
				}
				result <- err
			}()
			time.Sleep(100 * time.Millisecond)
			s.stop()
			code, elapsed := s.wait()
			if code != 0 || elapsed > time.Second {
				t.Errorf("exit %d after %v", code, elapsed)
			}
			if err := <-result; (err == nil) != c.drained {
				t.Errorf("request error %v", err)
			}
			var shutting, stopped logRecord
			for _, r := range parseLogRecords(t, s.stderr.String()) {
				switch r["msg"] {
				case "shutting down":
					shutting = r
				case "stopped":
					stopped = r
				}
			}
			if shutting == nil || shutting["signal"] != signal || stopped == nil || stopped["drained"] != c.drained {
				t.Errorf("records %s", s.stderr.String())
			}
		})
	}
}

func TestServeShutdown(t *testing.T) {
	testShutdown(t, startInProcess, "SIGINT")
}

func TestServeShutdownOnSIGTERM(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows has no SIGTERM")
	}
	testShutdown(t, startProcess, "SIGTERM")
}

func TestServeAnswersRequests(t *testing.T) {
	s := startInProcess(t, 0)
	eventually(t, "listening", func() bool { return strings.Contains(s.stderr.String(), `"msg":"listening"`) })
	for _, c := range []struct {
		path   string
		status int
	}{{"/healthz", 204}, {"/capabilities", 200}, {"/missing", 404}} {
		resp, err := http.Get("http://" + s.addr + c.path)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != c.status {
			t.Errorf("%s: %d", c.path, resp.StatusCode)
		}
	}
	if r := runCLI(t, nil, "", "healthcheck", "--url", "http://"+s.addr+"/healthz"); r.code != 0 {
		t.Errorf("healthcheck %+v", r)
	}
	s.stop()
	if code, _ := s.wait(); code != 0 {
		t.Errorf("exit %d", code)
	}
	var msgs []string
	for _, r := range parseLogRecords(t, s.stderr.String()) {
		msgs = append(msgs, r["msg"].(string))
	}
	want := "starting,routing tables loaded,listening,request,request,shutting down,stopped"
	if strings.Join(msgs, ",") != want {
		t.Errorf("records %v", msgs)
	}
}

func TestHealthcheck(t *testing.T) {
	handler := func(status int) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(status) })
	}
	healthy := httptest.NewServer(handler(204))
	defer healthy.Close()
	failing := httptest.NewServer(handler(500))
	defer failing.Close()
	redirect := httptest.NewServer(http.RedirectHandler(healthy.URL, http.StatusFound))
	defer redirect.Close()
	stalled := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(5 * time.Second):
		}
	}))
	defer stalled.Close()

	missing := map[string]string{tablesEnv: filepath.Join(t.TempDir(), "missing")}
	for _, c := range []struct {
		name, url string
		code      int
		stderr    string
	}{
		{"healthy", healthy.URL, 0, ""},
		{"server error", failing.URL, 1, "healthcheck failed: HTTP 500\n"},
		{"redirect", redirect.URL, 1, "healthcheck failed: HTTP 302\n"},
		{"refused", "http://127.0.0.1:" + strconv.Itoa(freePort(t)) + "/healthz", 1, "healthcheck failed: "},
		{"timeout", stalled.URL, 1, "healthcheck failed: "},
	} {
		t.Run(c.name, func(t *testing.T) {
			start := time.Now()
			// The tables don't need to exist.
			r := runCLI(t, missing, "", "--routing-tables", missing[tablesEnv], "healthcheck", "--url", c.url)
			if r.code != c.code || r.stdout != "" || !strings.HasPrefix(r.stderr, c.stderr) || strings.Count(r.stderr, "\n") > 1 {
				t.Errorf("got %+v", r)
			}
			if elapsed := time.Since(start); elapsed > 3*time.Second {
				t.Errorf("took %v", elapsed)
			}
		})
	}
	if cmd, err := parseArgs([]string{"healthcheck"}, func(string) string { return "" }); err != nil || cmd.url != defaultHealthURL {
		t.Errorf("default URL: %+v, %v", cmd, err)
	}
}
