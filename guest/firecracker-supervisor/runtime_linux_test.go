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
