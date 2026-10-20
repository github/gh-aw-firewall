package main

import (
	"bufio"
	"maps"
	"os"
	"slices"
	"strings"
	"testing"
)

// servedRoutes maps each path the server serves to its method.
var servedRoutes = map[string]string{"/healthz": "GET", "/capabilities": "GET", "/classify": "POST", "/route": "POST"}

// openAPIOutline is what the tests read from openapi.yaml.
type openAPIOutline struct {
	routes     map[string][]string // path to every documented method
	errorCodes []ErrorCode
	refs       []string        // every $ref target
	components map[string]bool // every "#/components/<kind>/<name>"
}

// readOpenAPI reads openapi.yaml by indentation, which is enough for its fixed
// layout, so the tests need no YAML library.
func readOpenAPI(t *testing.T) openAPIOutline {
	t.Helper()
	f, err := os.Open("openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	o := openAPIOutline{routes: map[string][]string{}, components: map[string]bool{}}
	var section, path, kind string
	inErrorCodes := false
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		indent := len(line) - len(strings.TrimLeft(line, " "))
		if target, ok := strings.CutPrefix(strings.TrimPrefix(trimmed, "- "), "$ref: "); ok {
			o.refs = append(o.refs, strings.Trim(target, `"`))
		}
		switch {
		case indent == 0:
			section = trimmed
		case section == "paths:" && indent == 2:
			path = strings.TrimSuffix(trimmed, ":")
		case section == "paths:" && indent == 4:
			o.routes[path] = append(o.routes[path], strings.ToUpper(strings.TrimSuffix(trimmed, ":")))
		case section == "components:" && indent == 2:
			kind = strings.TrimSuffix(trimmed, ":")
		case section == "components:" && indent == 4:
			o.components["#/components/"+kind+"/"+strings.TrimSuffix(trimmed, ":")] = true
			inErrorCodes = kind == "schemas" && trimmed == "Error:"
		case inErrorCodes && indent == 12 && strings.HasPrefix(trimmed, "- "):
			o.errorCodes = append(o.errorCodes, ErrorCode(strings.TrimPrefix(trimmed, "- ")))
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	return o
}

func TestOpenAPIDocumentsServedRoutesAndErrorCodes(t *testing.T) {
	o := readOpenAPI(t)
	served := map[string][]string{}
	for path, method := range servedRoutes {
		served[path] = []string{method}
	}
	if !maps.EqualFunc(o.routes, served, slices.Equal) {
		t.Errorf("openapi.yaml documents %v, the server serves %v", o.routes, served)
	}
	want := []ErrorCode{CodeInvalidJSON, CodeInvalidRequest, CodePayloadTooLarge, CodeUnsupportedMediaType,
		CodeNotFound, CodeMethodNotAllowed, CodeNoRoute, CodeInternalError}
	if !slices.Equal(o.errorCodes, want) {
		t.Errorf("openapi.yaml documents error codes %v, want %v", o.errorCodes, want)
	}
}

// TestOpenAPIReferencesResolve checks that every $ref names a component that
// openapi.yaml defines.
func TestOpenAPIReferencesResolve(t *testing.T) {
	o := readOpenAPI(t)
	if len(o.refs) == 0 {
		t.Fatal("openapi.yaml has no references")
	}
	for _, ref := range o.refs {
		if !o.components[ref] {
			t.Errorf("openapi.yaml references %s, which it does not define", ref)
		}
	}
}
