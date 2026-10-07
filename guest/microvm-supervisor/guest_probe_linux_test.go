//go:build linux

package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strings"
	"syscall"
	"testing"
)

// The live guest probe runs the real enclave supervisor setup against the
// kernel: bounded tmpfs mounts, rlimits, an all-thread privilege drop, a
// read-only root mount, and the --awf-enclave-exec trampoline. The workload
// then attempts to exceed every limit and must observe kernel enforcement.
// It requires root and a cgo-free test binary:
//
//	CGO_ENABLED=0 go test -c -o microvm-supervisor.test .
//	sudo AWF_REQUIRE_LIVE_GUEST_PROBE=1 ./microvm-supervisor.test -test.run '^TestEnclaveGuestLimitsLive$' -test.v
const (
	guestProbeStageEnv   = "AWF_TEST_GUEST_PROBE_STAGE"
	guestProbeDirEnv     = "AWF_TEST_GUEST_PROBE_DIR"
	guestProbeRequireEnv = "AWF_REQUIRE_LIVE_GUEST_PROBE"
	guestProbeArgv0      = "awf-guest-probe"
	guestProbePassed     = "awf guest probe passed"
)

func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "--awf-enclave-exec" {
		if err := runEnclaveExec(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, "microvm-supervisor:", err)
			os.Exit(126)
		}
		os.Exit(0)
	}
	if os.Args[0] == guestProbeArgv0 {
		os.Exit(runGuestWorkloadProbe())
	}
	if os.Getenv(guestProbeStageEnv) == "supervisor" {
		os.Exit(runGuestSupervisorProbe())
	}
	os.Exit(m.Run())
}

func TestEnclaveGuestLimitsLive(t *testing.T) {
	required := os.Getenv(guestProbeRequireEnv) == "1"
	skip := func(reason string) {
		if required {
			t.Fatal(reason)
		}
		t.Skip(reason)
	}
	if os.Geteuid() != 0 {
		skip("live enclave guest probe requires root")
	}
	if _, _, errno := syscall.AllThreadsSyscall(syscall.SYS_GETPID, 0, 0, 0); errno == syscall.ENOTSUP {
		skip("live enclave guest probe requires a CGO_ENABLED=0 test binary")
	}
	workDir, err := os.MkdirTemp("/var/tmp", "awf-guest-probe-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(workDir)
	if err := os.Chmod(workDir, 0755); err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	probe := filepath.Join(workDir, "probe")
	if err := copyExecutable(executable, probe); err != nil {
		t.Fatal(err)
	}
	readOnly := filepath.Join(workDir, "read-only")
	if err := os.Mkdir(readOnly, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chown(readOnly, 65534, 65534); err != nil {
		t.Fatal(err)
	}
	command := exec.Command(probe)
	command.Env = append(os.Environ(), guestProbeStageEnv+"=supervisor", guestProbeDirEnv+"="+workDir)
	command.SysProcAttr = &syscall.SysProcAttr{Cloneflags: syscall.CLONE_NEWNS}
	output, err := command.CombinedOutput()
	t.Logf("guest probe output:\n%s", output)
	if err != nil || !strings.Contains(string(output), guestProbePassed) {
		t.Fatalf("enclave guest limits were not enforced: %v", err)
	}
}

func copyExecutable(source, destination string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(output, input); err != nil {
		output.Close()
		return err
	}
	return output.Close()
}

// runGuestSupervisorProbe mirrors runSupervisorWithCmdline for the agent role
// inside a private mount namespace, then launches the workload probe exactly as
// session.start does.
func runGuestSupervisorProbe() int {
	fail := func(format string, args ...any) int {
		fmt.Fprintf(os.Stderr, "supervisor probe: "+format+"\n", args...)
		return 1
	}
	directory := os.Getenv(guestProbeDirEnv)
	runtime.LockOSThread()
	if err := syscall.Mount("", "/", "", syscall.MS_REC|syscall.MS_PRIVATE, ""); err != nil {
		return fail("make mounts private: %v", err)
	}
	// The real rootfs ships /home/awf-enclave; give the host a private parent.
	if err := syscall.Mount("tmpfs", "/home", "tmpfs", syscall.MS_NOSUID|syscall.MS_NODEV, "size=1m,mode=755"); err != nil {
		return fail("mount private /home: %v", err)
	}
	profile, err := enclaveResourceProfileForRole("agent")
	if err != nil {
		return fail("%v", err)
	}
	if err := mountEnclaveTmpfs(profile); err != nil {
		return fail("%v", err)
	}
	if err := applyEnclaveRlimits(profile); err != nil {
		return fail("%v", err)
	}
	if err := syscall.Mount("", "/", "", syscall.MS_REMOUNT|syscall.MS_BIND|syscall.MS_RDONLY, ""); err != nil {
		return fail("remount root read-only: %v", err)
	}
	readOnly := filepath.Join(directory, "read-only")
	var stats syscall.Statfs_t
	if err := syscall.Statfs(readOnly, &stats); err != nil {
		return fail("stat read-only probe directory: %v", err)
	}
	if stats.Flags&0x1 == 0 {
		if err := syscall.Mount(readOnly, readOnly, "", syscall.MS_BIND, ""); err != nil {
			return fail("bind read-only probe directory: %v", err)
		}
		if err := syscall.Mount("", readOnly, "", syscall.MS_REMOUNT|syscall.MS_BIND|syscall.MS_RDONLY, ""); err != nil {
			return fail("remount read-only probe directory: %v", err)
		}
	}
	if err := dropEnclaveSupervisorPrivileges(); err != nil {
		return fail("%v", err)
	}
	probe := filepath.Join(directory, "probe")
	command := exec.Command(probe, "--awf-enclave-exec", "agent", probe, guestProbeArgv0)
	command.Dir = "/"
	command.Env = []string{"PATH=/usr/bin:/bin", guestProbeDirEnv + "=" + directory}
	command.SysProcAttr = &syscall.SysProcAttr{
		Setpgid:    true,
		Credential: &syscall.Credential{Uid: profile.uid, Gid: profile.gid, NoSetGroups: true},
	}
	output, err := command.CombinedOutput()
	os.Stdout.Write(output)
	if err != nil {
		return fail("workload probe failed: %v", err)
	}
	fmt.Println(guestProbePassed)
	return 0
}

func runGuestWorkloadProbe() int {
	profile, err := enclaveResourceProfileForRole("agent")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	directory := os.Getenv(guestProbeDirEnv)
	checks := []struct {
		name  string
		check func() error
	}{
		{"identity", func() error {
			groups, err := os.Getgroups()
			if err != nil {
				return err
			}
			if os.Getuid() != 65534 || os.Geteuid() != 65534 || os.Getgid() != 65534 || os.Getegid() != 65534 || len(groups) != 0 {
				return fmt.Errorf("uid=%d euid=%d gid=%d egid=%d groups=%v", os.Getuid(), os.Geteuid(), os.Getgid(), os.Getegid(), groups)
			}
			return nil
		}},
		{"capabilities and no_new_privs", func() error {
			return verifyEnclaveThreads("/proc/self/task", validateEnclaveCapabilities)
		}},
		{"rlimits", func() error { return verifyEnclaveRlimits(profile) }},
		{"/tmp capacity", func() error { return expectTmpfsFull("/tmp/awf-fill", profile.primaryTmpfsMax) }},
		{"/dev/shm capacity", func() error { return expectTmpfsFull("/dev/shm/awf-fill", 32*1024*1024) }},
		{"/home/awf-enclave capacity", func() error {
			return expectTmpfsFull("/home/awf-enclave/awf-fill", 32*1024*1024)
		}},
		{"file size limit", func() error { return expectFileSizeLimit("/tmp/awf-sparse", profile.maxFileBytes) }},
		{"open file limit", func() error { return expectOpenFileLimit(profile.maxOpenFiles) }},
		{"process limit", func() error { return expectProcessLimit(profile.maxProcesses) }},
		{"read-only storage", func() error {
			for _, path := range []string{filepath.Join(directory, "read-only", "write"), "/awf-guest-probe-write"} {
				if err := os.WriteFile(path, []byte("x"), 0600); !errors.Is(err, syscall.EROFS) {
					return fmt.Errorf("write %s: got %v, want EROFS", path, err)
				}
			}
			return nil
		}},
	}
	failed := false
	for _, check := range checks {
		if err := check.check(); err != nil {
			fmt.Printf("FAIL %s: %v\n", check.name, err)
			failed = true
		} else {
			fmt.Printf("ok   %s\n", check.name)
		}
	}
	if failed {
		return 1
	}
	return 0
}

func expectTmpfsFull(path string, limit uint64) error {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer os.Remove(path)
	defer file.Close()
	chunk := make([]byte, 1024*1024)
	var written uint64
	for written <= limit {
		count, err := file.Write(chunk)
		written += uint64(count)
		if err != nil {
			if !errors.Is(err, syscall.ENOSPC) {
				return fmt.Errorf("after %d bytes: got %v, want ENOSPC", written, err)
			}
			return nil
		}
	}
	return fmt.Errorf("wrote %d bytes beyond the %d-byte tmpfs limit", written, limit)
}

func expectFileSizeLimit(path string, limit uint64) error {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer os.Remove(path)
	defer file.Close()
	if err := file.Truncate(int64(limit) + 1); !errors.Is(err, syscall.EFBIG) {
		return fmt.Errorf("truncate beyond limit: got %v, want EFBIG", err)
	}
	if _, err := file.WriteAt([]byte{1}, int64(limit)); !errors.Is(err, syscall.EFBIG) {
		return fmt.Errorf("write beyond limit: got %v, want EFBIG", err)
	}
	return nil
}

func expectOpenFileLimit(limit uint64) error {
	var descriptors []int
	defer func() {
		for _, descriptor := range descriptors {
			syscall.Close(descriptor)
		}
	}()
	for uint64(len(descriptors)) <= limit {
		descriptor, err := syscall.Open("/dev/null", syscall.O_RDONLY|syscall.O_CLOEXEC, 0)
		if err != nil {
			if !errors.Is(err, syscall.EMFILE) {
				return fmt.Errorf("after %d opens: got %v, want EMFILE", len(descriptors), err)
			}
			return nil
		}
		descriptors = append(descriptors, descriptor)
	}
	return fmt.Errorf("opened %d files beyond the %d limit", len(descriptors), limit)
}

func expectProcessLimit(limit uint64) error {
	// Ensure runtime helper threads exist before the user reaches its limit.
	runtime.GC()
	defer debug.SetGCPercent(debug.SetGCPercent(-1))
	sleep := "/bin/sleep"
	if _, err := os.Stat(sleep); err != nil {
		sleep = "/usr/bin/sleep"
	}
	var children []int
	defer func() {
		for _, pid := range children {
			syscall.Kill(pid, syscall.SIGKILL)
			var status syscall.WaitStatus
			syscall.Wait4(pid, &status, 0, nil)
		}
	}()
	for uint64(len(children)) <= limit {
		pid, err := syscall.ForkExec(sleep, []string{"sleep", "60"}, &syscall.ProcAttr{})
		if err != nil {
			if !errors.Is(err, syscall.EAGAIN) {
				return fmt.Errorf("after %d processes: got %v, want EAGAIN", len(children), err)
			}
			return nil
		}
		children = append(children, pid)
	}
	return fmt.Errorf("started %d processes beyond the %d limit", len(children), limit)
}
