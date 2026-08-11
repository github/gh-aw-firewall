//go:build linux

package main

import (
	"os"
	"path/filepath"
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
