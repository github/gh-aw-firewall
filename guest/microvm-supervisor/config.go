package main

import (
	"encoding/base64"
	"fmt"
	"net"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	maxVirtiofsMounts   = 8
	maxVirtiofsArgBytes = 4096
)

type virtiofsMount struct {
	Tag      string
	Target   string
	ReadOnly bool
}

type bootConfig struct {
	WorkspaceDevice string
	WorkspaceMount  string
	VsockPort       uint32
	EnclaveRole     string
	NoNetwork       bool
	GuestIP         net.IP
	GuestPrefix     int
	Gateway         net.IP
	Interface       string
	VirtiofsMounts  []virtiofsMount
}

func parseBootConfig(cmdline string) (bootConfig, error) {
	values := make(map[string]string)
	for _, token := range strings.Fields(cmdline) {
		key, value, ok := strings.Cut(token, "=")
		if !ok || !strings.HasPrefix(key, "awf.") {
			continue
		}
		if _, duplicate := values[key]; duplicate {
			return bootConfig{}, fmt.Errorf("duplicate boot argument %q", key)
		}
		values[key] = value
	}
	noNetwork := values["awf.network-mode"] == "none"
	if _, present := values["awf.network-mode"]; present && !noNetwork {
		return bootConfig{}, fmt.Errorf("invalid awf.network-mode")
	}
	if role, present := values["awf.enclave-role"]; present && role != "script" && role != "agent" {
		return bootConfig{}, fmt.Errorf("invalid awf.enclave-role")
	}
	if values["awf.enclave-role"] == "script" && !noNetwork {
		return bootConfig{}, fmt.Errorf("script enclave must not configure guest networking")
	}
	if values["awf.enclave-role"] == "agent" && noNetwork {
		return bootConfig{}, fmt.Errorf("agent enclave requires its dedicated network")
	}
	required := []string{"awf.vsock-port"}
	if !noNetwork {
		required = append(required,
			"awf.guest-ip", "awf.guest-prefix", "awf.guest-gateway", "awf.guest-interface")
	} else {
		for _, key := range []string{
			"awf.workspace-device", "awf.workspace-mount",
			"awf.guest-ip", "awf.guest-prefix", "awf.guest-gateway", "awf.guest-interface",
		} {
			if _, present := values[key]; present {
				return bootConfig{}, fmt.Errorf("awf.network-mode=none cannot include %q", key)
			}
		}
	}
	for _, key := range required {
		if values[key] == "" {
			return bootConfig{}, fmt.Errorf("missing required boot argument %q", key)
		}
	}
	port, err := strconv.ParseUint(values["awf.vsock-port"], 10, 32)
	if err != nil || port == 0 {
		return bootConfig{}, fmt.Errorf("invalid awf.vsock-port")
	}
	var prefix int
	var ip, gateway net.IP
	if !noNetwork {
		prefix, err = strconv.Atoi(values["awf.guest-prefix"])
		if err != nil || prefix < 0 || prefix > 32 {
			return bootConfig{}, fmt.Errorf("invalid awf.guest-prefix")
		}
		ip = net.ParseIP(values["awf.guest-ip"]).To4()
		gateway = net.ParseIP(values["awf.guest-gateway"]).To4()
		if ip == nil || gateway == nil {
			return bootConfig{}, fmt.Errorf("guest IP and gateway must be IPv4 addresses")
		}
	}
	device := values["awf.workspace-device"]
	if device != "" && (!strings.HasPrefix(device, "/dev/") || filepath.Clean(device) != device || strings.Contains(device, "..")) {
		return bootConfig{}, fmt.Errorf("invalid awf.workspace-device")
	}
	workspaceMount := values["awf.workspace-mount"]
	if !noNetwork && workspaceMount != "" &&
		(!filepath.IsAbs(workspaceMount) || filepath.Clean(workspaceMount) != workspaceMount || workspaceMount == "/") {
		return bootConfig{}, fmt.Errorf("invalid awf.workspace-mount")
	}
	iface := values["awf.guest-interface"]
	if !noNetwork && !validInterface(iface) {
		return bootConfig{}, fmt.Errorf("invalid awf.guest-interface")
	}
	virtiofsMounts, err := parseVirtiofsMounts(values["awf.virtiofs"])
	if err != nil {
		return bootConfig{}, err
	}
	if noNetwork {
		for _, fsMount := range virtiofsMounts {
			if fsMount.Tag == "workspace" {
				return bootConfig{}, fmt.Errorf("workspace virtiofs mount is not allowed without a workspace")
			}
		}
	} else if workspaceMount == "" {
		if device != "" {
			return bootConfig{}, fmt.Errorf("awf.workspace-device requires awf.workspace-mount")
		}
		if values["awf.enclave-role"] != "" {
			if device != "" || workspaceMount != "" {
				return bootConfig{}, fmt.Errorf("enclave cannot declare a primary workspace")
			}
			for _, fsMount := range virtiofsMounts {
				if fsMount.Tag == "workspace" {
					return bootConfig{}, fmt.Errorf("enclave cannot declare a primary workspace export")
				}
			}
		}
		for _, fsMount := range virtiofsMounts {
			if fsMount.Tag == "workspace" {
				return bootConfig{}, fmt.Errorf("workspace virtiofs mount requires awf.workspace-mount")
			}
		}
	} else if device == "" {
		hasWorkspace := false
		for _, fsMount := range virtiofsMounts {
			if fsMount.Tag == "workspace" && fsMount.Target == workspaceMount {
				hasWorkspace = true
			}
		}
		if !hasWorkspace {
			return bootConfig{}, fmt.Errorf("workspace requires awf.workspace-device or workspace virtiofs mount")
		}
	} else {
		for _, fsMount := range virtiofsMounts {
			if pathsOverlap(workspaceMount, fsMount.Target) {
				return bootConfig{}, fmt.Errorf("virtiofs target overlaps workspace device mount")
			}
		}
	}
	return bootConfig{
		WorkspaceDevice: device, WorkspaceMount: workspaceMount, VsockPort: uint32(port),
		EnclaveRole: values["awf.enclave-role"], NoNetwork: noNetwork,
		GuestIP: ip, GuestPrefix: prefix, Gateway: gateway, Interface: iface,
		VirtiofsMounts: virtiofsMounts,
	}, nil
}

func parseVirtiofsMounts(value string) ([]virtiofsMount, error) {
	if value == "" {
		return nil, nil
	}
	if len(value) > maxVirtiofsArgBytes {
		return nil, fmt.Errorf("awf.virtiofs exceeds maximum length")
	}
	entries := strings.Split(value, ";")
	if len(entries) > maxVirtiofsMounts {
		return nil, fmt.Errorf("awf.virtiofs exceeds maximum mount count")
	}
	tags := make(map[string]bool)
	targets := make([]string, 0, len(entries))
	mounts := make([]virtiofsMount, 0, len(entries))
	for _, entry := range entries {
		parts := strings.Split(entry, ":")
		if len(parts) != 3 || !validVirtiofsTag(parts[0]) {
			return nil, fmt.Errorf("invalid awf.virtiofs entry")
		}
		if tags[parts[0]] {
			return nil, fmt.Errorf("duplicate virtiofs tag %q", parts[0])
		}
		decoded, err := base64.RawURLEncoding.Strict().DecodeString(parts[1])
		if err != nil {
			return nil, fmt.Errorf("invalid virtiofs target encoding")
		}
		target := string(decoded)
		if !safeMountTarget(target) {
			return nil, fmt.Errorf("invalid virtiofs target")
		}
		for _, existing := range targets {
			if pathsOverlap(existing, target) {
				return nil, fmt.Errorf("overlapping virtiofs targets")
			}
		}
		readOnly := parts[2] == "ro"
		if !readOnly && parts[2] != "rw" {
			return nil, fmt.Errorf("invalid virtiofs mount mode")
		}
		tags[parts[0]] = true
		targets = append(targets, target)
		mounts = append(mounts, virtiofsMount{Tag: parts[0], Target: target, ReadOnly: readOnly})
	}
	return mounts, nil
}

func validVirtiofsTag(value string) bool {
	if value == "" || len(value) > 36 {
		return false
	}
	for index, r := range value {
		if !(r == '-' || r == '_' || r == '.' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9') {
			return false
		}
		if index == 0 && !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')) {
			return false
		}
	}
	return true
}

func safeMountTarget(value string) bool {
	if len(value) > 4096 || !filepath.IsAbs(value) || filepath.Clean(value) != value || value == "/" {
		return false
	}
	for _, protected := range []string{"/boot", "/dev", "/etc", "/proc", "/run", "/sys", "/usr"} {
		if value == protected || strings.HasPrefix(value, protected+"/") {
			return false
		}
	}
	return true
}

func pathsOverlap(first, second string) bool {
	if first == second {
		return true
	}
	relative, err := filepath.Rel(first, second)
	if err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return true
	}
	relative, err = filepath.Rel(second, first)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func validInterface(name string) bool {
	if name == "" || len(name) > 15 {
		return false
	}
	for i, r := range name {
		if !(r == '-' || r == '_' || r == '.' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || (i > 0 && r >= '0' && r <= '9')) {
			return false
		}
	}
	return true
}
