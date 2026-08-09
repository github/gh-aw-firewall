package main

import (
	"fmt"
	"net"
	"path/filepath"
	"strconv"
	"strings"
)

type bootConfig struct {
	WorkspaceDevice string
	WorkspaceMount  string
	VsockPort       uint32
	GuestIP         net.IP
	GuestPrefix     int
	Gateway         net.IP
	Interface       string
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
	required := []string{
		"awf.workspace-device", "awf.workspace-mount", "awf.vsock-port",
		"awf.guest-ip", "awf.guest-prefix", "awf.guest-gateway", "awf.guest-interface",
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
	prefix, err := strconv.Atoi(values["awf.guest-prefix"])
	if err != nil || prefix < 0 || prefix > 32 {
		return bootConfig{}, fmt.Errorf("invalid awf.guest-prefix")
	}
	ip := net.ParseIP(values["awf.guest-ip"]).To4()
	gateway := net.ParseIP(values["awf.guest-gateway"]).To4()
	if ip == nil || gateway == nil {
		return bootConfig{}, fmt.Errorf("guest IP and gateway must be IPv4 addresses")
	}
	device := values["awf.workspace-device"]
	if !strings.HasPrefix(device, "/dev/") || filepath.Clean(device) != device || strings.Contains(device, "..") {
		return bootConfig{}, fmt.Errorf("invalid awf.workspace-device")
	}
	mount := values["awf.workspace-mount"]
	if !filepath.IsAbs(mount) || filepath.Clean(mount) != mount || mount == "/" {
		return bootConfig{}, fmt.Errorf("invalid awf.workspace-mount")
	}
	iface := values["awf.guest-interface"]
	if !validInterface(iface) {
		return bootConfig{}, fmt.Errorf("invalid awf.guest-interface")
	}
	return bootConfig{
		WorkspaceDevice: device, WorkspaceMount: mount, VsockPort: uint32(port),
		GuestIP: ip, GuestPrefix: prefix, Gateway: gateway, Interface: iface,
	}, nil
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
