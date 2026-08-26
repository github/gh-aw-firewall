package main

// Host/guest transport contract, contract version 1.
//
// This file is the guest half of the contract whose host half lives in
// src/apple-container/transport-capabilities.ts. Both halves are compiled in,
// so no configuration crosses the VM boundary at boot and there is nothing for
// a workload to influence. src/apple-container/transport-contract-sync.test.ts
// parses this file and fails the build if the two halves ever diverge.

// ContractVersion is embedded in GuestDirectory so a host and a guest init
// image that disagree cannot silently half-work.
const ContractVersion = 1

// GuestDirectory holds every socket published with --publish-socket. /run is a
// tmpfs in the guest, so this stays writable under a read-only rootfs.
const GuestDirectory = "/run/awf/transport/v1"

// InitEntrypoint is where Apple's containerization runtime executes the init
// binary from inside the init image. The AWF init image installs this shim
// there and relocates Apple's original binary to RealInitPath.
const InitEntrypoint = "/sbin/vminitd"

// RealInitPath is Apple's unmodified vminitd, relocated at image build time.
// The shim execs it after the relay is confirmed listening, so Apple's init
// keeps PID 1 and its reaping and lifecycle semantics are untouched.
const RealInitPath = "/sbin/vminitd.apple"

// RelayFlag selects relay mode when the shim re-executes itself.
const RelayFlag = "--awf-relay"

// ReadyFD is the inherited pipe (child fd 3) the relay writes ReadyToken to
// once every loopback listener is bound. The shim refuses to exec the real init
// until it reads that token, so a workload can never start before its
// capability endpoints exist.
const ReadyFD = 3

// ReadyToken is the exact line the relay writes to ReadyFD.
const ReadyToken = "awf-relay-ready"

// Capability is one allowlisted host service reachable from the guest.
type Capability struct {
	ID         string
	SocketName string
	GuestPort  int
}

// Capabilities is the complete allowlist. There is no dynamic extension point:
// a socket published at any other guest path is simply never served, and a
// loopback port not listed here is never bound.
//
// Every port is bound unconditionally at boot. Binding a port whose host socket
// was not published is deliberate and safe: the dial fails and the connection is
// closed with no data, which is the same fail-closed outcome as a disabled
// capability, and it removes any race between the relay and workload startup.
var Capabilities = []Capability{
	{ID: "squid", SocketName: "squid.sock", GuestPort: 3128},
	{ID: "api-proxy-openai", SocketName: "api-proxy-openai.sock", GuestPort: 10000},
	{ID: "api-proxy-anthropic", SocketName: "api-proxy-anthropic.sock", GuestPort: 10001},
	{ID: "api-proxy-copilot", SocketName: "api-proxy-copilot.sock", GuestPort: 10002},
	{ID: "api-proxy-gemini", SocketName: "api-proxy-gemini.sock", GuestPort: 10003},
	{ID: "cli-proxy", SocketName: "cli-proxy.sock", GuestPort: 11000},
	{ID: "mcp-gateway", SocketName: "mcp-gateway.sock", GuestPort: 8080},
}

// SocketPath is the guest path a capability's socket is published at.
func (c Capability) SocketPath() string {
	return GuestDirectory + "/" + c.SocketName
}
