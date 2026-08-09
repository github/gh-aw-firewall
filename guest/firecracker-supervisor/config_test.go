package main

import "testing"

const validCmdline = "console=ttyS0 awf.workspace-device=/dev/vdb awf.workspace-mount=/workspace awf.vsock-port=1024 awf.guest-ip=192.0.2.2 awf.guest-prefix=24 awf.guest-gateway=192.0.2.1 awf.guest-interface=eth0"

func TestParseBootConfig(t *testing.T) {
	config, err := parseBootConfig(validCmdline)
	if err != nil {
		t.Fatalf("parseBootConfig: %v", err)
	}
	if config.VsockPort != 1024 || config.Interface != "eth0" || config.GuestIP.String() != "192.0.2.2" {
		t.Fatalf("unexpected config: %#v", config)
	}
}

func TestParseBootConfigRejectsUnsafeValues(t *testing.T) {
	cases := []string{
		"awf.workspace-device=/dev/vdb awf.workspace-mount=/workspace awf.vsock-port=0 awf.guest-ip=192.0.2.2 awf.guest-prefix=24 awf.guest-gateway=192.0.2.1 awf.guest-interface=eth0",
		"awf.workspace-device=/dev/../etc/passwd awf.workspace-mount=/workspace awf.vsock-port=1 awf.guest-ip=192.0.2.2 awf.guest-prefix=24 awf.guest-gateway=192.0.2.1 awf.guest-interface=eth0",
		"awf.workspace-device=/dev/vdb awf.workspace-mount=/ awf.vsock-port=1 awf.guest-ip=192.0.2.2 awf.guest-prefix=24 awf.guest-gateway=192.0.2.1 awf.guest-interface=eth0",
		"awf.workspace-device=/dev/vdb awf.workspace-mount=/workspace awf.vsock-port=1 awf.guest-ip=bad awf.guest-prefix=24 awf.guest-gateway=192.0.2.1 awf.guest-interface=eth0",
	}
	for _, cmdline := range cases {
		if _, err := parseBootConfig(cmdline); err == nil {
			t.Errorf("unsafe command line accepted: %q", cmdline)
		}
	}
}

func TestParseBootConfigRejectsDuplicateArguments(t *testing.T) {
	if _, err := parseBootConfig(validCmdline + " awf.vsock-port=1025"); err == nil {
		t.Fatal("duplicate argument accepted")
	}
}
