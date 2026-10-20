package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json/v2"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// The container tests run the built image hardened as AWF does, with no capabilities and
// no-new-privileges, and also with a read-only root filesystem, which the router doesn't write.
// Build the image first, for example
// docker build --build-arg OPENAPI_SHA256=<sha256 of openapi.yaml> -t gh-aw-router:test .
// then run GH_AW_ROUTER_TEST_IMAGE=gh-aw-router:test go test -run Container .
func containerImage(t *testing.T) string {
	t.Helper()
	image := os.Getenv("GH_AW_ROUTER_TEST_IMAGE")
	if image == "" {
		t.Skip("GH_AW_ROUTER_TEST_IMAGE is not set")
	}
	return image
}

func docker(t *testing.T, args ...string) string {
	t.Helper()
	out, err := exec.Command("docker", args...).CombinedOutput()
	if err != nil {
		t.Fatalf("docker %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

// container is a running router container.
type container struct {
	id, url string
}

// startContainer runs the image hardened, publishes the port on loopback and waits until
// the healthcheck subcommand, which AWF's compose config runs, succeeds.
func startContainer(t *testing.T, image string, args ...string) container {
	t.Helper()
	run := []string{"run", "-d", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
		"--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "512m",
		"--pids-limit", "100", "-p", "127.0.0.1::8737"}
	id := docker(t, append(append(run, args...), image)...)
	t.Cleanup(func() {
		if t.Failed() {
			out, _ := exec.Command("docker", "logs", id).CombinedOutput()
			t.Logf("container logs:\n%s", out)
		}
		_ = exec.Command("docker", "rm", "-f", id).Run()
	})
	c := container{id: id, url: "http://" + docker(t, "port", id, "8737/tcp")}
	for deadline := time.Now().Add(20 * time.Second); ; time.Sleep(200 * time.Millisecond) {
		if exec.Command("docker", "exec", id, "/usr/local/bin/gh-aw-router", "healthcheck").Run() == nil {
			return c
		}
		if time.Now().After(deadline) {
			t.Fatal("the container did not become healthy")
		}
	}
}

func (c container) do(t *testing.T, method, path string, header map[string]string, body []byte) (int, []byte) {
	t.Helper()
	req, err := http.NewRequest(method, c.url+path, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range header {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, data
}

func TestContainerImageConfig(t *testing.T) {
	image := containerImage(t)
	var config struct {
		User         string
		ExposedPorts map[string]any
		Entrypoint   []string
		Env          []string
		Labels       map[string]string
		Healthcheck  any
	}
	if err := json.Unmarshal([]byte(docker(t, "image", "inspect", "-f", "{{json .Config}}", image)), &config); err != nil {
		t.Fatal(err)
	}
	if config.User != "10001:10001" {
		t.Errorf("User = %q, want 10001:10001", config.User)
	}
	if _, ok := config.ExposedPorts["8737/tcp"]; !ok || len(config.ExposedPorts) != 1 {
		t.Errorf("ExposedPorts = %v, want only 8737/tcp", config.ExposedPorts)
	}
	if !slices.Equal(config.Entrypoint, []string{"/usr/local/bin/gh-aw-router"}) {
		t.Errorf("Entrypoint = %v", config.Entrypoint)
	}
	if !slices.Contains(config.Env, "GH_AW_ROUTER_ROUTING_TABLES=/routing") {
		t.Errorf("Env = %v, want GH_AW_ROUTER_ROUTING_TABLES=/routing", config.Env)
	}
	if config.Healthcheck != nil {
		t.Errorf("Healthcheck = %v, want none: AWF's compose config sets it", config.Healthcheck)
	}
	contract, err := os.ReadFile("openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(contract)
	for label, want := range map[string]string{
		"org.opencontainers.image.version":      version,
		"org.opencontainers.image.source":       "https://github.com/github/gh-aw-firewall",
		"io.github.gh-aw-router.openapi-sha256": hex.EncodeToString(sum[:]),
	} {
		if got := config.Labels[label]; got != want {
			t.Errorf("label %s = %q, want %q", label, got, want)
		}
	}
}

func TestContainerServesBundledTables(t *testing.T) {
	c := startContainer(t, containerImage(t))
	status, body := c.do(t, "GET", "/capabilities", nil, nil)
	if status != 200 {
		t.Fatalf("GET /capabilities: HTTP %d: %s", status, body)
	}
	var caps struct {
		Version  string `json:"version"`
		Profiles []any  `json:"routing_profiles"`
	}
	if err := json.Unmarshal(body, &caps); err != nil {
		t.Fatal(err)
	}
	bundled, _ := filepath.Glob(filepath.Join("routing", "cost-*.json"))
	if caps.Version != version || len(caps.Profiles) != len(bundled) {
		t.Errorf("capabilities report version %q and %d profiles, want %q and %d", caps.Version, len(caps.Profiles), version, len(bundled))
	}
	if exec.Command("docker", "exec", c.id, "sh", "-c", "true").Run() == nil {
		t.Error("the image has a shell")
	}

	// AWF tears the stack down with docker compose down -t 1, so the router has 1 s between
	// SIGTERM and SIGKILL; a container still running then is killed with 137.
	docker(t, "stop", "-t", "1", c.id)
	if code := docker(t, "inspect", "-f", "{{.State.ExitCode}}", c.id); code != "0" {
		t.Errorf("exit code %s after SIGTERM, want 0", code)
	}
	logs := docker(t, "logs", c.id)
	for line := range strings.Lines(logs) {
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Errorf("log line is not JSON: %q", line)
		}
	}
	if !strings.Contains(logs, `"msg":"stopped"`) {
		t.Errorf("no stopped record in logs:\n%s", logs)
	}
}

// TestContainerRoutingContractCorpus replays the corpus against the image with the contract
// tables mounted. Single-profile cases mount one table file instead of a directory.
func TestContainerRoutingContractCorpus(t *testing.T) {
	image := containerImage(t)
	docs := contractDocuments()
	groups := map[string][]corpusCase{}
	for _, c := range loadCorpus(t) {
		names := slices.Clone(c.Profiles)
		if names == nil {
			for name := range docs {
				names = append(names, name)
			}
		}
		slices.Sort(names)
		key := strings.Join(names, ",")
		groups[key] = append(groups[key], c)
	}
	for key, cases := range groups {
		t.Run(key, func(t *testing.T) {
			dir := t.TempDir()
			names := strings.Split(key, ",")
			// The container user must be able to read the mount on Linux hosts. Chmod sets
			// the modes exactly; WriteFile's mode is reduced by the umask.
			for _, name := range names {
				path := filepath.Join(dir, name)
				if err := os.WriteFile(path, marshal(t, docs[name]), 0o644); err != nil {
					t.Fatal(err)
				}
				if err := os.Chmod(path, 0o644); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.Chmod(dir, 0o755); err != nil {
				t.Fatal(err)
			}
			mount := []string{"-v", dir + ":/routing:ro"}
			if len(names) == 1 {
				mount = []string{"-v", filepath.Join(dir, names[0]) + ":/tables/" + names[0] + ":ro",
					"-e", "GH_AW_ROUTER_ROUTING_TABLES=/tables/" + names[0]}
			}
			c := startContainer(t, image, mount...)
			for _, tc := range cases {
				status, body := c.do(t, tc.Method, tc.Path, tc.header(), tc.body())
				checkCorpusResponse(t, tc, status, body)
			}
		})
	}
}
