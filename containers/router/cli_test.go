package main

import (
	"bytes"
	"encoding/json/v2"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestMain lets the CLI process tests run the test binary as the command itself.
// GH_AW_ROUTER_TEST_HOLD holds /capabilities requests open for a duration, after
// writing "holding" to stdout, for the shutdown tests.
func TestMain(m *testing.M) {
	if os.Getenv("GH_AW_ROUTER_TEST_MAIN") == "1" {
		if hold, err := time.ParseDuration(os.Getenv("GH_AW_ROUTER_TEST_HOLD")); err == nil {
			testHold = holding(hold, func() { fmt.Println("holding") })
		}
		main()
	}
	os.Exit(m.Run())
}

type cliResult struct {
	code           int
	stdout, stderr string
}

func runCLI(t *testing.T, env map[string]string, stdin string, args ...string) cliResult {
	t.Helper()
	var stdout, stderr strings.Builder
	code := run(args, func(k string) string { return env[k] }, strings.NewReader(stdin), &stdout, &stderr)
	return cliResult{code, stdout.String(), stderr.String()}
}

func bundledTables(t *testing.T) string {
	t.Helper()
	path, err := filepath.Abs("routing")
	if err != nil {
		t.Fatal(err)
	}
	return path
}

func exampleRequest(t *testing.T, command string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("examples", command+"-request.json"))
	if err != nil {
		t.Fatal(err)
	}
	var req map[string]any
	if err := json.Unmarshal(data, &req); err != nil {
		t.Fatal(err)
	}
	return req
}

// expectedOutput is what the service itself answers for the request.
func expectedOutput(t *testing.T, tables, command string, body []byte) string {
	t.Helper()
	service, err := LoadService(tables)
	if err != nil {
		t.Fatal(err)
	}
	var result any
	if command == "classify" {
		req, err := DecodeClassifyRequest(body)
		if err != nil {
			t.Fatal(err)
		}
		result, err = service.Classify(req)
		if err != nil {
			t.Fatal(err)
		}
	} else {
		req, err := DecodeRouteRequest(body)
		if err != nil {
			t.Fatal(err)
		}
		result, err = service.Route(req)
		if err != nil {
			t.Fatal(err)
		}
	}
	return string(marshal(t, result)) + "\n"
}

func TestCLIPlanningCommandsWriteOnlyTheResponse(t *testing.T) {
	tables := bundledTables(t)
	for _, command := range []string{"classify", "route"} {
		body := marshal(t, exampleRequest(t, command))
		want := expectedOutput(t, tables, command, body)
		input := filepath.Join(t.TempDir(), "request.json")
		if err := os.WriteFile(input, body, 0o600); err != nil {
			t.Fatal(err)
		}
		for name, r := range map[string]cliResult{
			"stdin": runCLI(t, nil, string(body), "--routing-tables", tables, command),
			"input": runCLI(t, nil, "", "--routing-tables", tables, command, "--input", input),
		} {
			if r.code != 0 || r.stderr != "" || r.stdout != want {
				t.Errorf("%s via %s: %+v\nwant stdout %s", command, name, r, want)
			}
		}
	}
}

func TestCLIWritesUnicodeAsUTF8(t *testing.T) {
	tables := bundledTables(t)
	const text = "Fix the parser 修复"
	for _, command := range []string{"classify", "route"} {
		req := exampleRequest(t, command)
		req["conversation"].([]any)[0].(map[string]any)["parts"] = []any{map[string]any{"text": text}}
		req["models"].([]any)[0].(map[string]any)["id"] = "choice-修"
		r := runCLI(t, nil, string(marshal(t, req)), "--routing-tables", tables, command)
		if r.code != 0 || r.stderr != "" {
			t.Fatalf("%s: %+v", command, r)
		}
		if !strings.Contains(r.stdout, `"choice-修"`) {
			t.Errorf("%s: stdout lacks the raw choice id: %s", command, r.stdout)
		}
		if command == "classify" && !strings.Contains(r.stdout, text) {
			t.Errorf("classify prompt lacks %q", text)
		}
	}
}

func TestCLIErrorsUseStderrAndExitStatus(t *testing.T) {
	tables := bundledTables(t)
	noModels := exampleRequest(t, "route")
	noModels["models"] = []any{}
	unsupported := exampleRequest(t, "classify")
	unsupported["models"] = []any{map[string]any{"id": "unsupported", "model": "provider/unknown"}}
	empty := t.TempDir()
	tests := []struct {
		name   string
		stdin  string
		args   []string
		code   int
		prefix string
	}{
		{"empty route", "{}", []string{"--routing-tables", tables, "route"}, 2, "invalid request:"},
		{"invalid UTF-8", "{\"conversation\":\"\xff\"}", []string{"--routing-tables", tables, "classify"}, 2, "invalid request:"},
		{"missing input", "", []string{"--routing-tables", tables, "route", "--input", filepath.Join(empty, "missing.json")}, 2, "invalid request:"},
		{"missing tables", "", []string{"--routing-tables", filepath.Join(empty, "routing.json"), "validate-data"}, 2, "invalid model data:"},
		{"empty tables", "", []string{"--routing-tables", empty, "validate-data"}, 2, "invalid model data:"},
		{"no models", string(marshal(t, noModels)), []string{"--routing-tables", tables, "route"}, 3, "no route:"},
		{"unsupported models", string(marshal(t, unsupported)), []string{"--routing-tables", tables, "classify"}, 3, "no route:"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := runCLI(t, nil, tt.stdin, tt.args...)
			if r.code != tt.code || r.stdout != "" || !strings.HasPrefix(r.stderr, tt.prefix) || !strings.HasSuffix(r.stderr, "\n") {
				t.Errorf("got %+v; want exit %d and %q", r, tt.code, tt.prefix)
			}
		})
	}
	if r := runCLI(t, nil, "", "--routing-tables", empty, "validate-data"); !strings.Contains(r.stderr, "holds no tables") {
		t.Errorf("empty directory: %q", r.stderr)
	}
}

type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) { return 0, errors.New("broken pipe") }

func TestCLIReportsOutputWriteFailure(t *testing.T) {
	var stderr strings.Builder
	code := run([]string{"--routing-tables", bundledTables(t), "validate-data"}, func(string) string { return "" }, strings.NewReader(""), failingWriter{}, &stderr)
	if code != 1 || stderr.String() != "write error: broken pipe\n" {
		t.Errorf("exit %d, stderr %q", code, stderr.String())
	}
}

func TestCLIValidateDataReportsTheSummary(t *testing.T) {
	r := runCLI(t, nil, "", "--routing-tables", bundledTables(t), "validate-data")
	want := `{"label_cells":210,"models":40,"profiles":["cost-speed/balanced","cost-speed/economy","cost-speed/robust","cost/balanced","cost/economy","cost/robust"],"repository":"global"}` + "\n"
	if r.code != 0 || r.stderr != "" || r.stdout != want {
		t.Errorf("got %+v", r)
	}
}

func TestCLIRoutingTablesPrecedence(t *testing.T) {
	tables := bundledTables(t)
	missing := filepath.Join(t.TempDir(), "missing")
	env := func(v string) map[string]string { return map[string]string{tablesEnv: v} }
	ok := func(name string, r cliResult) {
		t.Helper()
		if r.code != 0 || r.stderr != "" {
			t.Errorf("%s: %+v", name, r)
		}
	}
	ok("flag over environment", runCLI(t, env(missing), "", "--routing-tables", tables, "validate-data"))
	ok("empty environment uses ./routing", runCLI(t, env(""), "", "validate-data"))
	if r := runCLI(t, env(missing), "", "validate-data"); r.code != 2 || !strings.HasPrefix(r.stderr, "invalid model data:") {
		t.Errorf("environment path is used: %+v", r)
	}

	t.Chdir(t.TempDir())
	ok("environment", runCLI(t, env(tables), "", "validate-data"))
	r := runCLI(t, nil, "", "validate-data")
	if r.code != 2 || r.stdout != "" || !strings.Contains(r.stderr, "gh-aw-router: error: --routing-tables or "+tablesEnv+" is required") {
		t.Errorf("missing default tables: %+v", r)
	}
}

func TestCLIVersion(t *testing.T) {
	r := runCLI(t, nil, "", "--routing-tables", filepath.Join(t.TempDir(), "missing"), "--version")
	if r.code != 0 || r.stderr != "" || r.stdout != "gh-aw-router "+version+"\n" {
		t.Errorf("got %+v", r)
	}
}

func TestCLIUsage(t *testing.T) {
	tables := bundledTables(t)
	for _, args := range [][]string{
		{"-h"},
		{"--help"},
		{"--routing-tables", tables, "route", "--help"},
	} {
		if r := runCLI(t, nil, "", args...); r.code != 0 || r.stderr != "" || r.stdout != usage {
			t.Errorf("%v: %+v", args, r)
		}
	}
	for _, args := range [][]string{
		{},
		{"--routing-tables", tables},
		{"--routing-tables", tables, "serve", "--input", "request.json"},
		{"--routing-tables", tables, "serve", "extra"},
		{"--routing-tables", tables, "healthcheck", "--bind", "127.0.0.1:1"},
		{"--routing-tables", tables, "unknown"},
		{"--routing-tables", tables, "route", "--inp", "request.json"},
		{"--routing-tables", tables, "validate-data", "--input", "request.json"},
		{"--routing-tables", tables, "route", "extra"},
		{"--routing-tables"},
	} {
		r := runCLI(t, nil, "", args...)
		if r.code != 2 || r.stdout != "" || !strings.HasPrefix(r.stderr, usage) || !strings.Contains(r.stderr, "gh-aw-router: error: ") {
			t.Errorf("%v: %+v", args, r)
		}
	}
}

// TestCLIProcess runs the command as a real process, so that stdin, stdout, stderr
// and exit statuses cross a process boundary on every platform.
func TestCLIProcess(t *testing.T) {
	tables := bundledTables(t)
	request := marshal(t, exampleRequest(t, "route"))
	noRoute := exampleRequest(t, "route")
	noRoute["models"] = []any{}
	tests := []struct {
		name   string
		stdin  []byte
		args   []string
		code   int
		stdout string
		stderr string
	}{
		{"route", request, []string{"--routing-tables", tables, "route"}, 0, expectedOutput(t, tables, "route", request), ""},
		{"version", nil, []string{"--version"}, 0, "gh-aw-router " + version + "\n", ""},
		{"invalid request", []byte("{"), []string{"--routing-tables", tables, "route"}, 2, "", "invalid request: "},
		{"no route", marshal(t, noRoute), []string{"--routing-tables", tables, "route"}, 3, "", "no route: "},
		{"usage", nil, []string{"unknown"}, 2, "", "usage: gh-aw-router "},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cmd := exec.Command(os.Args[0], tt.args...)
			cmd.Env = append(os.Environ(), "GH_AW_ROUTER_TEST_MAIN=1", tablesEnv+"=")
			cmd.Stdin = bytes.NewReader(tt.stdin)
			var stdout, stderr bytes.Buffer
			cmd.Stdout, cmd.Stderr = &stdout, &stderr
			err := cmd.Run()
			code := 0
			if exit := (*exec.ExitError)(nil); errors.As(err, &exit) {
				code = exit.ExitCode()
			} else if err != nil {
				t.Fatal(err)
			}
			if code != tt.code || stdout.String() != tt.stdout || !strings.HasPrefix(stderr.String(), tt.stderr) {
				t.Errorf("exit %d\nstdout %q\nstderr %q", code, stdout.String(), stderr.String())
			}
		})
	}
}
