//go:build linux

package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Production host staging is executed before the real guest mounts, privilege
// restrictions, session.start and execution trampoline. Only inference is fake.
const stageSessionProbe = `
const fs = require("fs").promises;
const path = require("path");
const { execFileSync } = require("child_process");
const staging = require(process.env.AWF_TEST_STAGING);
(async () => {
  const root = process.env.AWF_TEST_INVOCATION_ROOT;
  const invocationsDir = path.join(root, "invocations");
  await fs.mkdir(invocationsDir, { mode: 0o700 });
  const invocationHostDir = path.join(invocationsDir, "entry", "invocation");
  const plan = { entryId: "entry", invocationHostDir, payload: "Write true to /awf/out.", schema: { type: "boolean" } };
  const deps = {
    ...fs, resolveIdentity: () => ({ uid: 0, gid: 0 }),
    // /tmp is only the disposable test allocation ancestor, not an export.
    lstat: async p => {
      const info = await fs.lstat(p);
      if (p === "/tmp") info.mode &= ~0o022;
      return info;
    },
    mountTmpfs: async (p, size, uid, gid) => execFileSync("/usr/bin/mount",
      ["-t", "tmpfs", "-o", "size=" + size + ",mode=700,uid=" + uid + ",gid=" + gid, "tmpfs", p]),
    verifyStorage: async () => undefined,
  };
  const done = async () => {};
  await staging.prepareInvocationFilesystem({ invocationsDir }, plan, "agent", deps, {}, done, done, done, done);
  await staging.stageInvocationInputs(plan, "agent",
    { model: "test", profile: "openai", maxOutputBytes: 4096 }, deps);
  if (process.env.AWF_TEST_SESSION_SCENARIO === "legacy") {
    await fs.writeFile(path.join(invocationHostDir, "runtime", "session.jsonl"), "", { mode: 0o644 });
  }
})().catch(e => { console.error(e); process.exit(1); });
`

const sessionProbeEngine = `#!/usr/bin/python3
import errno, json, os, signal, sys
assert os.getresuid() == (65534, 65534, 65534)
assert os.getresgid() == (65534, 65534, 65534)
assert os.getgroups() == []
status = dict(line.split(":", 1) for line in open("/proc/self/status") if ":" in line)
assert int(status["CapEff"].strip(), 16) == 0
assert int(status["CapPrm"].strip(), 16) == 0
assert status["NoNewPrivs"].strip() == "1"
for action in (
    lambda: os.setuid(0),
    lambda: os.kill(os.getppid(), signal.SIGUSR1),
    lambda: open("/proc/%d/fd/1" % os.getppid(), "w"),
    lambda: open("/session-state/session.jsonl", "ab"),
    lambda: os.unlink("/session-state/session.jsonl"),
):
    try:
        action()
    except PermissionError:
        pass
    else:
        raise AssertionError("engine reached trusted writer")
if os.environ["AWF_TEST_SESSION_SCENARIO"] == "engine-failure":
    sys.exit(1)
open("/awf/out", "w").write("true")
if os.environ["AWF_ENCLAVE_AGENT_ENGINE"] == "claude":
    print(json.dumps({"type": "result", "is_error": False}))
`

func testEnclaveSessionLogLive(t *testing.T) {
	_, source, _, _ := runtime.Caller(0)
	repository := filepath.Clean(filepath.Join(filepath.Dir(source), "../.."))
	staging := filepath.Join(repository, "dist/cloud-hypervisor/enclave-invocation-staging.js")
	if _, err := os.Stat(staging); err != nil {
		t.Fatalf("build the host staging code with npm run build before the live guest probe: %v", err)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, engine := range []string{"copilot", "codex", "claude"} {
		for _, scenario := range []string{"legacy", "success", "engine-failure", "inaccessible", "unsafe-mode", "unsafe-parent", "hardlink", "symlink", "read-only"} {
			t.Run(engine+"/"+scenario, func(t *testing.T) {
				root, err := os.MkdirTemp("/tmp", "awf-session-probe-")
				if err != nil {
					t.Fatal(err)
				}
				defer os.RemoveAll(root)
				command := exec.Command(executable)
				command.Env = []string{
					"PATH=/usr/local/bin:/usr/bin:/bin", guestProbeStageEnv + "=session-supervisor",
					guestProbeDirEnv + "=" + root, "AWF_TEST_NODE=" + node,
					"AWF_TEST_STAGING=" + staging,
					"AWF_TEST_ENTRYPOINT=" + filepath.Join(repository, "containers/enclave/agent-entrypoint.py"),
					"AWF_ENCLAVE_AGENT_ENGINE=" + engine, "AWF_TEST_SESSION_SCENARIO=" + scenario,
				}
				command.SysProcAttr = &syscall.SysProcAttr{Cloneflags: syscall.CLONE_NEWNS}
				output, err := command.CombinedOutput()
				t.Logf("%s", output)
				if err != nil || !strings.Contains(string(output), "session probe passed") {
					t.Fatalf("session permission contract failed: %v", err)
				}
			})
		}
	}
}

func runSessionSupervisorProbe() int {
	fail := func(err error) int {
		fmt.Fprintln(os.Stderr, "session probe:", err)
		return 1
	}
	root := os.Getenv(guestProbeDirEnv)
	engine := os.Getenv("AWF_ENCLAVE_AGENT_ENGINE")
	scenario := os.Getenv("AWF_TEST_SESSION_SCENARIO")
	if err := syscall.Mount("", "/", "", syscall.MS_REC|syscall.MS_PRIVATE, ""); err != nil {
		return fail(err)
	}
	stage := exec.Command(os.Getenv("AWF_TEST_NODE"), "-e", stageSessionProbe)
	stage.Env = append(os.Environ(), "AWF_TEST_INVOCATION_ROOT="+root)
	if output, err := stage.CombinedOutput(); err != nil {
		return fail(fmt.Errorf("production staging: %v: %s", err, output))
	}
	invocation := filepath.Join(root, "invocations/entry/invocation")
	sessionFile := filepath.Join(invocation, "session-state/session.jsonl")
	switch scenario {
	case "inaccessible":
		if err := os.Chmod(sessionFile, 0400); err != nil {
			return fail(err)
		}
	case "unsafe-mode":
		if err := os.Chmod(sessionFile, 0666); err != nil {
			return fail(err)
		}
	case "unsafe-parent":
		if err := os.Chmod(filepath.Dir(sessionFile), 0777); err != nil {
			return fail(err)
		}
	case "hardlink":
		if err := os.Link(sessionFile, sessionFile+".alias"); err != nil {
			return fail(err)
		}
	case "symlink":
		if err := os.Rename(sessionFile, sessionFile+".target"); err != nil {
			return fail(err)
		}
		if err := os.Symlink("session.jsonl.target", sessionFile); err != nil {
			return fail(err)
		}
	}
	guest := filepath.Join(root, "guest")
	for _, directory := range []string{"usr", "proc", "agent", "runtime", "input-seed", "input-request", "output", "session-state", "awf", "tmp", "run", "dev/shm", "home/awf-enclave"} {
		if err := os.MkdirAll(filepath.Join(guest, directory), 0755); err != nil {
			return fail(err)
		}
	}
	for name, target := range map[string]string{"bin": "usr/bin", "lib": "usr/lib", "lib64": "usr/lib64"} {
		if err := os.Symlink(target, filepath.Join(guest, name)); err != nil {
			return fail(err)
		}
	}
	bind := func(source, target string, readOnly bool) error {
		destination := filepath.Join(guest, target)
		if err := syscall.Mount(source, destination, "", syscall.MS_BIND, ""); err != nil {
			return err
		}
		if readOnly {
			return syscall.Mount("", destination, "", syscall.MS_BIND|syscall.MS_REMOUNT|syscall.MS_RDONLY, "")
		}
		return nil
	}
	null := filepath.Join(guest, "dev/null")
	if err := os.WriteFile(null, nil, 0600); err != nil {
		return fail(err)
	}
	if err := bind("/dev/null", "dev/null", true); err != nil {
		return fail(err)
	}
	if err := bind("/usr", "usr", true); err != nil {
		return fail(err)
	}
	for _, directory := range []string{"usr/local", "usr/sbin"} {
		if err := syscall.Mount("tmpfs", filepath.Join(guest, directory), "tmpfs", syscall.MS_NOSUID|syscall.MS_NODEV, "size=64m,mode=755"); err != nil {
			return fail(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(guest, "usr/local/bin"), 0755); err != nil {
		return fail(err)
	}
	entrypoint, err := os.ReadFile(os.Getenv("AWF_TEST_ENTRYPOINT"))
	if err != nil {
		return fail(err)
	}
	if err := os.WriteFile(filepath.Join(guest, enclaveAgentEntrypoint), entrypoint, 0755); err != nil {
		return fail(err)
	}
	if err := os.WriteFile(filepath.Join(guest, "usr/local/bin", engine), []byte(sessionProbeEngine), 0755); err != nil {
		return fail(err)
	}
	executable, err := os.Executable()
	if err != nil {
		return fail(err)
	}
	if err := copyExecutable(executable, filepath.Join(guest, "usr/sbin/awf-supervisor")); err != nil {
		return fail(err)
	}
	for source, target := range map[string]string{"request": "input-request", "output": "output", "runtime": "runtime", "session-state": "session-state"} {
		if err := bind(filepath.Join(invocation, source), target, source == "request" || scenario == "read-only" && source == "session-state"); err != nil {
			return fail(err)
		}
	}
	if err := syscall.Mount("proc", filepath.Join(guest, "proc"), "proc", syscall.MS_NOSUID|syscall.MS_NODEV|syscall.MS_NOEXEC, ""); err != nil {
		return fail(err)
	}
	if err := syscall.Mount(guest, guest, "", syscall.MS_BIND|syscall.MS_REC, ""); err != nil {
		return fail(err)
	}
	if err := syscall.Mount("", guest, "", syscall.MS_BIND|syscall.MS_REMOUNT|syscall.MS_RDONLY, ""); err != nil {
		return fail(err)
	}
	if err := syscall.Chroot(guest); err != nil {
		return fail(err)
	}
	if err := os.Chdir("/"); err != nil {
		return fail(err)
	}
	profile, _ := enclaveResourceProfileForRole("agent")
	if err := mountEnclaveTmpfs(profile); err != nil {
		return fail(err)
	}
	if err := mountEnclaveAgentRuntime(bootConfig{VirtiofsMounts: []virtiofsMount{{Tag: enclaveRuntimeTag, Target: enclaveRuntimeSource}}}); err != nil {
		return fail(err)
	}
	if err := mountEnclaveCompatibilityPaths("agent"); err != nil {
		return fail(err)
	}
	if scenario == "legacy" {
		if err := os.Remove("/awf/session.jsonl"); err != nil {
			return fail(err)
		}
		if err := os.Symlink("/runtime/session.jsonl", "/awf/session.jsonl"); err != nil {
			return fail(err)
		}
	}
	if err := applyEnclaveRlimits(profile); err != nil {
		return fail(err)
	}
	if err := dropEnclaveSupervisorPrivileges(); err != nil {
		return fail(err)
	}
	env := map[string]string{
		"PATH": "/usr/local/bin:/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1",
		"AWF_ENCLAVE_AGENT_ENGINE": engine, "AWF_TEST_SESSION_SCENARIO": scenario,
		"AWF_ENCLAVE_AGENT_MODEL": "test", "AWF_ENCLAVE_AGENT_MAX_OUTPUT_BYTES": "4096",
		"AWF_ENCLAVE_AGENT_DEADLINE_SECONDS": "10", "OPENAI_API_KEY": "test-placeholder",
		"ANTHROPIC_API_KEY":              "test-placeholder",
		"AWF_ENCLAVE_AGENT_API_ENDPOINT": "http://172.31.0.30:10001",
	}
	if engine == "codex" {
		env["AWF_ENCLAVE_AGENT_API_ENDPOINT"] = "http://172.31.0.30:10000"
	}
	exitCode := -1
	if scenario == "legacy" {
		command := exec.Command(enclaveAgentEntrypoint)
		command.Env = environment(env)
		command.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: profile.uid, Gid: profile.gid, NoSetGroups: true}}
		output, err := command.CombinedOutput()
		if exit, ok := err.(*exec.ExitError); ok {
			exitCode = exit.ExitCode()
		}
		if exitCode != 24 || !strings.Contains(string(output), "permission-denied") {
			return fail(fmt.Errorf("legacy reproduction: exit=%d error=%v output=%s", exitCode, err, output))
		}
		fmt.Println("session probe passed: reproduced UID/GID 65534 transcript denial")
		return 0
	}
	sockets, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM|syscall.SOCK_CLOEXEC|syscall.SOCK_NONBLOCK, 0)
	if err != nil {
		return fail(err)
	}
	server := os.NewFile(uintptr(sockets[0]), "session-server")
	client := os.NewFile(uintptr(sockets[1]), "session-client")
	defer server.Close()
	defer client.Close()
	client.SetReadDeadline(time.Now().Add(20 * time.Second))
	s := session{connection: server, config: bootConfig{EnclaveRole: "agent"}}
	if err := s.start(Frame{RequestID: "session-probe", Argv: []string{enclaveAgentEntrypoint}, Env: env, Cwd: "/", UID: 65534, GID: 65534}); err != nil {
		return fail(err)
	}
	for exitCode < 0 {
		frame, err := ReadFrame(client)
		if err != nil {
			return fail(err)
		}
		if frame.Type == "result" && frame.ExitCode != nil {
			exitCode = *frame.ExitCode
		}
		if frame.Type == "stderr" && frame.Data != nil {
			data, _ := base64.StdEncoding.DecodeString(*frame.Data)
			os.Stderr.Write(data)
		}
	}
	if scenario != "success" && exitCode != 24 || scenario == "success" && exitCode != 0 {
		return fail(fmt.Errorf("unexpected %s exit code %d", scenario, exitCode))
	}
	transcript, err := os.ReadFile("/session-state/session.jsonl")
	if err != nil {
		return fail(err)
	}
	if len(transcript) > 1024*1024 {
		return fail(fmt.Errorf("unbounded transcript"))
	}
	if scenario == "success" || scenario == "engine-failure" {
		text := string(transcript)
		if !strings.Contains(text, `"stage":"preflight-completed","valid":true`) ||
			!strings.Contains(text, `"stage":"engine-started"`) {
			return fail(fmt.Errorf("missing preflight/engine transcript: %s", text))
		}
		if scenario == "success" {
			if err := syscall.Seteuid(int(profile.uid)); err != nil {
				return fail(err)
			}
			output, err := os.ReadFile("/output/out")
			if restoreErr := syscall.Seteuid(0); restoreErr != nil {
				return fail(restoreErr)
			}
			var value bool
			if err != nil || json.Unmarshal(output, &value) != nil || !value {
				return fail(fmt.Errorf("missing schema-approved result: %v", err))
			}
		} else if !strings.Contains(text, `"event":"failure"`) {
			return fail(fmt.Errorf("missing failure transcript"))
		}
		fmt.Println(text)
	} else if len(transcript) != 0 {
		return fail(fmt.Errorf("unsafe transcript was written"))
	}
	fmt.Println("session probe passed")
	return 0
}
