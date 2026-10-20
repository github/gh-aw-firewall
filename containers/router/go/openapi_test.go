package main

import (
	"bufio"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// servedRoutes maps each path the server serves to its method.
var servedRoutes = map[string]string{"/healthz": "GET", "/capabilities": "GET", "/classify": "POST", "/route": "POST"}

// TestOpenAPIDocumentsServedRoutesAndErrorCodes reads openapi.yaml by indentation, which is
// enough for its fixed layout, so the test needs no YAML library.
func TestOpenAPIDocumentsServedRoutesAndErrorCodes(t *testing.T) {
	f, err := os.Open(filepath.Join(routerDir, "openapi.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	routes := map[string]string{}
	var codes []ErrorCode
	var section, path string
	inErrorCodes := false
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		trimmed := strings.TrimSpace(line)
		indent := len(line) - len(strings.TrimLeft(line, " "))
		switch {
		case indent == 0 && trimmed != "":
			section = trimmed
		case section == "paths:" && indent == 2:
			path = strings.TrimSuffix(trimmed, ":")
		case section == "paths:" && indent == 4:
			routes[path] = strings.ToUpper(strings.TrimSuffix(trimmed, ":"))
		case section == "components:" && indent == 4:
			inErrorCodes = trimmed == "Error:"
		case inErrorCodes && indent == 12 && strings.HasPrefix(trimmed, "- "):
			codes = append(codes, ErrorCode(strings.TrimPrefix(trimmed, "- ")))
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	if !maps.Equal(routes, servedRoutes) {
		t.Errorf("openapi.yaml documents %v, the server serves %v", routes, servedRoutes)
	}
	want := []ErrorCode{CodeInvalidJSON, CodeInvalidRequest, CodePayloadTooLarge, CodeUnsupportedMediaType,
		CodeNotFound, CodeMethodNotAllowed, CodeNoRoute, CodeInternalError}
	if !slices.Equal(codes, want) {
		t.Errorf("openapi.yaml documents error codes %v, want %v", codes, want)
	}
}
