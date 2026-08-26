// awf-apple-guest-init is the AWF init shim for Apple Container guests that run
// with `--network none`.
//
// The guest has zero network interfaces, so the only way it can reach an AWF
// service is through a Unix socket published with `--publish-socket`. Most
// tooling — curl, npm, pip, the agent CLIs — speaks TCP to a proxy endpoint and
// cannot be pointed at a Unix socket, so something inside the VM has to bridge
// the two. That is this binary.
//
// Boot sequence:
//
//	containerization exec /sbin/vminitd   (this shim)
//	  -> re-exec self with --awf-relay as a child
//	  -> child binds every allowlisted 127.0.0.1 port, writes "awf-relay-ready"
//	     on fd 3
//	  -> shim reads the token, then syscall.Exec()s /sbin/vminitd.apple
//	  -> Apple's real vminitd becomes PID 1 with its own argv and environment
//	     and takes over the boot unchanged
//
// The handoff is an exec, not a supervision tree, so Apple's init keeps PID 1
// and its reaping, signal, and lifecycle semantics are exactly what Apple
// shipped. The shim contributes nothing at runtime beyond the background relay.
//
// Every failure path exits non-zero without exec'ing the real init. That is the
// fail-closed guarantee the host side depends on: a guest that cannot serve its
// capabilities never reaches the workload at all, so there is no window in
// which an agent runs with partial or missing egress mediation.
package main

import (
	"bufio"
	"errors"

	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

var version = "dev"

// relayReadyTimeout bounds how long the shim waits for the relay to bind. It is
// generous relative to seven loopback binds but still finite, so a wedged relay
// fails the boot instead of hanging it.
const relayReadyTimeout = 20 * time.Second

func main() {
	args := os.Args[1:]
	if len(args) > 0 && args[0] == RelayFlag {
		if err := runRelay(); err != nil {
			fmt.Fprintln(os.Stderr, "awf-apple-guest-init relay:", err)
			os.Exit(1)
		}
		return
	}
	if len(args) == 1 && (args[0] == "--version" || args[0] == "-version") {
		fmt.Println(version)
		return
	}

	if err := runInit(); err != nil {
		fmt.Fprintln(os.Stderr, "awf-apple-guest-init:", err)
		os.Exit(1)
	}
}

// runRelay binds every allowlisted loopback port, reports readiness, and serves
// until it is signalled.
func runRelay() error {
	relays, err := bindRelays(Capabilities)
	if err != nil {
		return err
	}
	for _, r := range relays {
		go r.serve()
	}
	if err := signalReady(readyPipe()); err != nil {
		for _, r := range relays {
			r.close()
		}
		return err
	}

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	<-signals
	for _, r := range relays {
		r.close()
	}
	return nil
}

// runInit starts the relay, waits for it, and hands off to Apple's real init.
// It only returns on error; on success the process image is replaced.
func runInit() error {
	realInit, err := resolveRealInit(RealInitPath)
	if err != nil {
		return err
	}

	self, err := os.Executable()
	if err != nil {
		return fmt.Errorf("could not resolve own executable: %w", err)
	}

	readReady, writeReady, err := os.Pipe()
	if err != nil {
		return fmt.Errorf("could not create readiness pipe: %w", err)
	}

	child := exec.Command(self, RelayFlag)
	child.Stdout = os.Stdout
	child.Stderr = os.Stderr
	child.ExtraFiles = []*os.File{writeReady} // becomes fd 3 in the child
	if err := child.Start(); err != nil {
		writeReady.Close()
		readReady.Close()
		return fmt.Errorf("could not start capability relay: %w", err)
	}
	// The parent must drop its copy of the write end, otherwise a relay that
	// dies without writing would leave the read below blocking forever.
	writeReady.Close()

	if err := awaitReady(readReady, relayReadyTimeout); err != nil {
		readReady.Close()
		_ = child.Process.Kill()
		_, _ = child.Process.Wait()
		return err
	}
	readReady.Close()

	// syscall.Exec replaces this process, so the relay child is inherited by
	// Apple's vminitd as PID 1 and is reaped by it like any other process.
	if err := syscall.Exec(realInit, os.Args, os.Environ()); err != nil {
		_ = child.Process.Kill()
		_, _ = child.Process.Wait()
		return fmt.Errorf("could not exec %s: %w", realInit, err)
	}
	return nil
}

// awaitReady reads exactly the readiness token, or fails.
func awaitReady(pipe *os.File, timeout time.Duration) error {
	type result struct {
		line string
		err  error
	}
	results := make(chan result, 1)
	go func() {
		reader := bufio.NewReaderSize(pipe, 64)
		// A bounded read: the token is a fixed short string and anything longer
		// or different is rejected rather than scanned.
		line, err := reader.ReadString('\n')
		results <- result{line: line, err: err}
	}()

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-timer.C:
		return fmt.Errorf("capability relay did not report ready within %s", timeout)
	case got := <-results:
		if got.err != nil {
			return fmt.Errorf("capability relay exited before reporting ready: %w", got.err)
		}
		if strings.TrimRight(got.line, "\n") != ReadyToken {
			return errors.New("capability relay sent an unexpected readiness token")
		}
		return nil
	}
}

// resolveRealInit verifies Apple's relocated init binary before the shim
// commits to exec'ing it.
func resolveRealInit(path string) (string, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return "", fmt.Errorf("Apple init binary %s is missing; the AWF init image must relocate it there: %w", path, err)
	}
	if info.Mode()&fs.ModeSymlink != 0 {
		return "", fmt.Errorf("Apple init binary %s is a symlink; refusing to exec a substituted path", path)
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("Apple init binary %s is not a regular file", path)
	}
	if info.Mode().Perm()&0o111 == 0 {
		return "", fmt.Errorf("Apple init binary %s is not executable", path)
	}
	if info.Mode().Perm()&0o022 != 0 {
		return "", fmt.Errorf("Apple init binary %s is group/world writable", path)
	}
	return path, nil
}
