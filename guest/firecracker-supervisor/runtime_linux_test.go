//go:build linux

package main

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestResolveCommandUsesRequestPath(t *testing.T) {
	directory := t.TempDir()
	commandPath := filepath.Join(directory, "demo")
	if err := os.WriteFile(commandPath, []byte("#!/bin/sh\n"), 0700); err != nil {
		t.Fatalf("write command: %v", err)
	}
	resolved, err := resolveCommand("demo", map[string]string{"PATH": directory})
	if err != nil {
		t.Fatalf("resolve command: %v", err)
	}
	if resolved != commandPath {
		t.Fatalf("resolved command mismatch: got %s want %s", resolved, commandPath)
	}
}

func TestResolveCommandRejectsRelativeExecutablePath(t *testing.T) {
	if _, err := resolveCommand("./demo", map[string]string{"PATH": "/usr/bin"}); err == nil {
		t.Fatal("expected relative executable path to fail")
	}
}

func TestWorkspaceMountArgsUseExt4Filesystem(t *testing.T) {
	// Regression test: the workspace device is always formatted as ext4
	// (see src/microvm/workspace.ts's `mkfs -t ext4`), but mountWorkspace()
	// previously passed an empty fstype string to syscall.Mount(), which
	// is only valid for bind/remount mounts (MS_BIND/MS_REMOUNT). For a
	// fresh mount of a raw block device this fails with ENODEV ("no such
	// device"), which made the guest supervisor's init process return an
	// error and the kernel panic with "Attempted to kill init!" on every
	// single guest boot — discovered via live-KVM validation, a genuine,
	// pre-existing defect shared by both the Firecracker and Cloud
	// Hypervisor backends (they share this guest supervisor binary).
	config := bootConfig{WorkspaceDevice: "/dev/vdb", WorkspaceMount: "/workspace"}
	source, target, fstype, flags := workspaceMountArgs(config)
	if source != config.WorkspaceDevice {
		t.Fatalf("source mismatch: got %s want %s", source, config.WorkspaceDevice)
	}

	if target != config.WorkspaceMount {
		t.Fatalf("target mismatch: got %s want %s", target, config.WorkspaceMount)
	}
	if fstype != "ext4" {
		t.Fatalf("fstype mismatch: got %q want %q (empty string is ENODEV for a fresh block-device mount)", fstype, "ext4")
	}
	if flags != 0 {
		t.Fatalf("unexpected mount flags: got %d want 0", flags)
	}
}

func TestDevptsMountArgsSupportPtyAllocation(t *testing.T) {
	source, target, fstype, flags, data := devptsMountArgs()
	if source != "devpts" || target != "/dev/pts" || fstype != "devpts" {
		t.Fatalf("unexpected devpts mount: source=%q target=%q fstype=%q", source, target, fstype)
	}
	if flags&(syscall.MS_NOSUID|syscall.MS_NOEXEC) != syscall.MS_NOSUID|syscall.MS_NOEXEC {
		t.Fatalf("devpts mount must disable suid and executable files: flags=%#x", flags)
	}
	if data != "gid=5,mode=0620,ptmxmode=0666" {
		t.Fatalf("unexpected devpts mount options: %q", data)
	}
}

func TestVirtiofsMountArgsUseSecurityFlags(t *testing.T) {
	source, target, fstype, flags := virtiofsMountArgs(virtiofsMount{
		Tag: "cache", Target: "/opt/cache", ReadOnly: true,
	})
	if source != "cache" || target != "/opt/cache" || fstype != "virtiofs" {
		t.Fatalf("unexpected virtiofs mount arguments: %q %q %q", source, target, fstype)
	}
	expected := uintptr(syscall.MS_NOSUID | syscall.MS_NODEV | syscall.MS_RDONLY)
	if flags != expected {
		t.Fatalf("unexpected virtiofs flags: got %d want %d", flags, expected)
	}
}

func TestUnmountConfiguredFilesystemsUsesReverseOrder(t *testing.T) {
	originalUnmount := unmountFilesystem
	defer func() { unmountFilesystem = originalUnmount }()
	var targets []string
	unmountFilesystem = func(target string, _ int) error {
		targets = append(targets, target)
		return nil
	}
	config := bootConfig{
		WorkspaceDevice: "/dev/vdb",
		WorkspaceMount:  "/workspace",
		VirtiofsMounts: []virtiofsMount{
			{Tag: "cache-one", Target: "/cache/one"},
			{Tag: "cache-two", Target: "/cache/two"},
		},
	}
	if err := unmountConfiguredFilesystems(config); err != nil {
		t.Fatalf("unmountConfiguredFilesystems: %v", err)
	}
	expected := []string{"/cache/two", "/cache/one", "/workspace"}
	for index := range expected {
		if targets[index] != expected[index] {
			t.Fatalf("unmount order mismatch: got %v want %v", targets, expected)
		}
	}
}

func TestShutdownRequestSyncsBeforeAcknowledging(t *testing.T) {
	// Regression test: a live-KVM investigation found the workspace-
	// copyback smoke case's own newly-written file missing entirely from
	// the host-side copy-back, despite the guest agent command completing
	// successfully. Root cause: serveClient's "shutdown" case previously
	// sent the "shutting_down" acknowledgment *before* shutdownGuest()'s
	// own syscall.Sync()+unmount() ran (that pair only executes after
	// serveClient returns to its caller). Once the host receives that
	// acknowledgment it proceeds to call Cloud Hypervisor's own
	// vm.shutdown/vmm.shutdown API, which can tear the VM down before the
	// guest ever gets to flush its page cache to the workspace block
	// device -- silently discarding writes the agent command made (e.g.
	// via a plain `printf > file` with no explicit fsync of its own).
	//
	// This exercises serveClient itself end-to-end over a real, connected
	// socketpair (matching its *os.File parameter type) and asserts that
	// syncFilesystems is called strictly before the "shutting_down" frame
	// is observed on the wire.
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		t.Fatalf("socketpair: %v", err)
	}
	serverEnd := os.NewFile(uintptr(fds[0]), "server")
	testEnd := os.NewFile(uintptr(fds[1]), "test")
	defer serverEnd.Close()
	defer testEnd.Close()

	var syncCalled, syncCalledBeforeShutdownFrame bool
	originalSync := syncFilesystems
	syncFilesystems = func() { syncCalled = true }
	defer func() { syncFilesystems = originalSync }()

	done := make(chan bool, 1)
	go func() { done <- serveClient(serverEnd, bootConfig{}) }()

	// Discard the initial "ready" frame serveClient sends on connect.
	if _, err := ReadFrame(testEnd); err != nil {
		t.Fatalf("read ready frame: %v", err)
	}
	if err := WriteFrame(testEnd, newFrame("shutdown", "req-1")); err != nil {
		t.Fatalf("write shutdown frame: %v", err)
	}
	reply, err := ReadFrame(testEnd)
	if err != nil {
		t.Fatalf("read shutting_down frame: %v", err)
	}
	syncCalledBeforeShutdownFrame = syncCalled
	if reply.Type != "shutting_down" {
		t.Fatalf("reply type mismatch: got %q want %q", reply.Type, "shutting_down")
	}
	if !syncCalledBeforeShutdownFrame {
		t.Fatal("syncFilesystems must be called before the shutting_down acknowledgment is sent")
	}
	if shouldShutdown := <-done; !shouldShutdown {
		t.Fatal("serveClient should report shutdown requested")
	}
}
