package main

import (
	"os"
	"testing"
)

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

func TestParseBootConfigAcceptsWorkspaceLessNoNetwork(t *testing.T) {
	config, err := parseBootConfig("awf.network-mode=none awf.enclave-role=script awf.vsock-port=1024 awf.virtiofs=seed:L3NlZWQ:ro")
	if err != nil {
		t.Fatalf("parse no-network config: %v", err)
	}
	if !config.NoNetwork || config.EnclaveRole != "script" || config.WorkspaceMount != "" || config.GuestIP != nil || len(config.VirtiofsMounts) != 1 {
		t.Fatalf("unexpected no-network config: %#v", config)
	}
}

func TestParseBootConfigAcceptsWorkspaceLessNetworkedVirtiofs(t *testing.T) {
	cmdline := os.Getenv("AWF_TEST_BOOT_CMDLINE")
	if cmdline == "" {
		cmdline = "awf.virtiofs=enclave-seed:L2lucHV0LXNlZWQ:ro;enclave-request:L2lucHV0LXJlcXVlc3Q:ro;enclave-output:L291dHB1dA:rw;enclave-runtime:L3J1bnRpbWU:rw;enclave-session-handoff:L3Nlc3Npb24taGFuZG9mZg:rw;enclave-session-state:L3Nlc3Npb24tc3RhdGU:rw awf.vsock-port=1024 awf.guest-ip=100.64.0.2 awf.guest-prefix=30 awf.guest-gateway=100.64.0.1 awf.guest-interface=eth0"
	}
	config, err := parseBootConfig(cmdline)
	if err != nil {
		t.Fatalf("parse workspace-less networked config: %v", err)
	}
	if config.NoNetwork || config.WorkspaceMount != "" || config.GuestIP.String() != "100.64.0.2" || len(config.VirtiofsMounts) != 6 {
		t.Fatalf("unexpected workspace-less networked config: %#v", config)
	}
}

func TestParseBootConfigRejectsMixedNetworkAndWorkspace(t *testing.T) {
	base := "awf.network-mode=none awf.vsock-port=1024 "
	for _, arg := range []string{
		"awf.guest-ip=192.0.2.2", "awf.guest-prefix=24",
		"awf.guest-gateway=192.0.2.1", "awf.guest-interface=eth0",
		"awf.workspace-device=/dev/vdb", "awf.workspace-mount=/workspace",
		"awf.virtiofs=workspace:L3dvcmtzcGFjZQ:rw",
	} {
		if _, err := parseBootConfig(base + arg); err == nil {
			t.Errorf("mixed no-network config accepted: %s", arg)
		}
	}
	for _, cmdline := range []string{
		"awf.network-mode=invalid " + validCmdline,
		"awf.enclave-role=untrusted " + validCmdline,
		"awf.network-mode= " + validCmdline,
		"awf.vsock-port=1024",
		"awf.network-mode=none awf.vsock-port=1024 awf.network-mode=none",
	} {
		if _, err := parseBootConfig(cmdline); err == nil {
			t.Errorf("invalid network mode accepted: %s", cmdline)
		}
	}
}

func TestParseBootConfigAcceptsVirtiofsWorkspace(t *testing.T) {
	cmdline := "awf.workspace-mount=/workspace awf.virtiofs=workspace:L3dvcmtzcGFjZQ:rw;tool-cache:L29wdC9jYWNoZQ:ro awf.vsock-port=1024 awf.guest-ip=192.0.2.2 awf.guest-prefix=24 awf.guest-gateway=192.0.2.1 awf.guest-interface=eth0"
	config, err := parseBootConfig(cmdline)
	if err != nil {
		t.Fatalf("parse virtiofs config: %v", err)
	}
	if config.WorkspaceDevice != "" || len(config.VirtiofsMounts) != 2 {
		t.Fatalf("unexpected virtiofs config: %#v", config)
	}
	if config.VirtiofsMounts[1].Target != "/opt/cache" || !config.VirtiofsMounts[1].ReadOnly {
		t.Fatalf("unexpected read-only mount: %#v", config.VirtiofsMounts[1])
	}
}

func TestParseBootConfigRejectsUnsafeVirtiofs(t *testing.T) {
	base := "awf.workspace-mount=/workspace awf.vsock-port=1024 awf.guest-ip=192.0.2.2 awf.guest-prefix=24 awf.guest-gateway=192.0.2.1 awf.guest-interface=eth0 "
	cases := []string{
		"awf.virtiofs=workspace:Ly4uL2V0Yw:rw",
		"awf.virtiofs=workspace:L3dvcmtzcGFjZQ:rw;workspace:L29wdA:ro",
		"awf.virtiofs=workspace:L3dvcmtzcGFjZQ:rw;cache:L3dvcmtzcGFjZS9jYWNoZQ:ro",
		"awf.virtiofs=workspace:L3dvcmtzcGFjZQ:bad",
		"awf.virtiofs=cache:L29wdA:ro",
		"awf.virtiofs=workspace:L3dvcmtzcGFjZQ:rw;proc:L3Byb2M:ro",
	}
	for _, value := range cases {
		if _, err := parseBootConfig(base + value); err == nil {
			t.Errorf("unsafe virtiofs config accepted: %q", value)
		}
	}
}
