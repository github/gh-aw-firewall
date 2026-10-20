package main

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// routerDir is the router project's directory, which holds the routing tables, schemas,
// examples, fixtures, OpenAPI contract and Dockerfile.
const routerDir = ".."

func TestVersionMatchesContractAndImage(t *testing.T) {
	tests := []struct {
		file   string
		prefix string
	}{
		{"openapi.yaml", "  version: "},
		{"Dockerfile", "ARG VERSION="},
	}
	for _, tt := range tests {
		t.Run(tt.file, func(t *testing.T) {
			got := firstLineValue(t, filepath.Join(routerDir, tt.file), tt.prefix)
			if got != version {
				t.Fatalf("%s declares version %q, want %q", tt.file, got, version)
			}
		})
	}
}

// firstLineValue returns the rest of the first line that starts with prefix.
func firstLineValue(t *testing.T, path, prefix string) string {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		if value, ok := strings.CutPrefix(scanner.Text(), prefix); ok {
			return strings.TrimSpace(value)
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	t.Fatalf("%s has no line starting with %q", path, prefix)
	return ""
}
