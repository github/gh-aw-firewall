package main

import (
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestCapabilitiesAreWellFormed(t *testing.T) {
	seenIDs := map[string]bool{}
	seenPorts := map[int]bool{}
	seenSockets := map[string]bool{}
	for _, capability := range Capabilities {
		if seenIDs[capability.ID] {
			t.Fatalf("duplicate capability id %q", capability.ID)
		}
		if seenPorts[capability.GuestPort] {
			t.Fatalf("duplicate guest port %d", capability.GuestPort)
		}
		if seenSockets[capability.SocketName] {
			t.Fatalf("duplicate socket name %q", capability.SocketName)
		}
		if capability.GuestPort < 1 || capability.GuestPort > 65535 {
			t.Fatalf("capability %q port out of range: %d", capability.ID, capability.GuestPort)
		}
		if capability.SocketName != capability.ID+".sock" {
			t.Fatalf("capability %q socket name %q does not follow <id>.sock", capability.ID, capability.SocketName)
		}
		if got, want := capability.SocketPath(), GuestDirectory+"/"+capability.SocketName; got != want {
			t.Fatalf("socket path = %q, want %q", got, want)
		}
		seenIDs[capability.ID] = true
		seenPorts[capability.GuestPort] = true
		seenSockets[capability.SocketName] = true
	}
	if !seenIDs["squid"] {
		t.Fatal("the squid capability is mandatory: it is the guest's only egress path")
	}
}

func TestGuestDirectoryEmbedsContractVersion(t *testing.T) {
	want := "/run/awf/transport/v" + strconv.Itoa(ContractVersion)
	if GuestDirectory != want {
		t.Fatalf("GuestDirectory = %q, want %q", GuestDirectory, want)
	}
}

// bindRelays must be all-or-nothing so the shim never execs the real init with
// a partial capability set.
func TestBindRelaysIsAllOrNothing(t *testing.T) {
	blocker, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer blocker.Close()
	blocked := blocker.Addr().(*net.TCPAddr).Port

	free, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	freePort := free.Addr().(*net.TCPAddr).Port
	free.Close()

	_, err = bindRelays([]Capability{
		{ID: "first", SocketName: "first.sock", GuestPort: freePort},
		{ID: "second", SocketName: "second.sock", GuestPort: blocked},
	})
	if err == nil {
		t.Fatal("expected bindRelays to fail on the occupied port")
	}
	if !strings.Contains(err.Error(), strconv.Itoa(blocked)) {
		t.Fatalf("error should name the port that failed: %v", err)
	}

	// The first listener must have been released, not leaked.
	reclaim, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(freePort))
	if err != nil {
		t.Fatalf("first listener was leaked after a partial bind: %v", err)
	}
	reclaim.Close()
}

func TestRelayForwardsBytesOverPublishedSocket(t *testing.T) {
	socketPath := filepath.Join(shortTempDir(t), "squid.sock")

	upstream, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatalf("listen unix: %v", err)
	}
	defer upstream.Close()

	go func() {
		conn, acceptErr := upstream.Accept()
		if acceptErr != nil {
			return
		}
		defer conn.Close()
		buffer := make([]byte, 32)
		read, readErr := conn.Read(buffer)
		if readErr != nil {
			return
		}
		_, _ = conn.Write([]byte("echo:" + string(buffer[:read])))
	}()

	r := newTestRelay(t, socketPath)
	defer r.close()

	client, err := net.Dial("tcp", r.listener.Addr().String())
	if err != nil {
		t.Fatalf("dial relay: %v", err)
	}
	defer client.Close()

	if _, err := client.Write([]byte("hello")); err != nil {
		t.Fatalf("write: %v", err)
	}
	_ = client.SetReadDeadline(time.Now().Add(5 * time.Second))
	buffer := make([]byte, 64)
	read, err := client.Read(buffer)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if got := string(buffer[:read]); got != "echo:hello" {
		t.Fatalf("relayed payload = %q, want %q", got, "echo:hello")
	}
}

// A capability whose host socket was never published must fail closed: the
// connection is closed with no data, never routed anywhere else.
func TestRelayClosesConnectionWhenSocketIsAbsent(t *testing.T) {
	r := newTestRelay(t, filepath.Join(shortTempDir(t), "absent.sock"))
	defer r.close()

	client, err := net.Dial("tcp", r.listener.Addr().String())
	if err != nil {
		t.Fatalf("dial relay: %v", err)
	}
	defer client.Close()

	_ = client.SetReadDeadline(time.Now().Add(5 * time.Second))
	buffer := make([]byte, 8)
	if _, err := client.Read(buffer); err == nil {
		t.Fatal("expected the relay to close the connection with no data")
	}
}

func TestRelayHalfCloseDeliversFullResponse(t *testing.T) {
	socketPath := filepath.Join(shortTempDir(t), "cap.sock")
	upstream, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatalf("listen unix: %v", err)
	}
	defer upstream.Close()

	go func() {
		conn, acceptErr := upstream.Accept()
		if acceptErr != nil {
			return
		}
		defer conn.Close()
		// Read to EOF (the client half-closes), then answer.
		buffer := make([]byte, 64)
		for {
			_, readErr := conn.Read(buffer)
			if readErr != nil {
				break
			}
		}
		_, _ = conn.Write([]byte("response-after-eof"))
	}()

	r := newTestRelay(t, socketPath)
	defer r.close()

	client, err := net.Dial("tcp", r.listener.Addr().String())
	if err != nil {
		t.Fatalf("dial relay: %v", err)
	}
	defer client.Close()
	if _, err := client.Write([]byte("request")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := client.(*net.TCPConn).CloseWrite(); err != nil {
		t.Fatalf("close write: %v", err)
	}

	_ = client.SetReadDeadline(time.Now().Add(5 * time.Second))
	buffer := make([]byte, 64)
	read, err := client.Read(buffer)
	if err != nil {
		t.Fatalf("read after half-close: %v", err)
	}
	if got := string(buffer[:read]); got != "response-after-eof" {
		t.Fatalf("payload = %q, want %q", got, "response-after-eof")
	}
}

func TestRelayCloseStopsAcceptingConnections(t *testing.T) {
	r := newTestRelay(t, filepath.Join(shortTempDir(t), "cap.sock"))
	address := r.listener.Addr().String()
	r.close()
	// close() is idempotent.
	r.close()

	if conn, err := net.DialTimeout("tcp", address, time.Second); err == nil {
		conn.Close()
		t.Fatal("relay accepted a connection after close")
	}
}

func TestSignalReadyWritesExactToken(t *testing.T) {
	read, write, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	defer read.Close()

	if err := signalReady(write); err != nil {
		t.Fatalf("signalReady: %v", err)
	}
	buffer := make([]byte, 64)
	n, err := read.Read(buffer)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if got := strings.TrimRight(string(buffer[:n]), "\n"); got != ReadyToken {
		t.Fatalf("token = %q, want %q", got, ReadyToken)
	}
}

func TestAwaitReadyRejectsUnexpectedToken(t *testing.T) {
	read, write, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	defer read.Close()
	go func() {
		_, _ = write.WriteString("not-the-token\n")
		write.Close()
	}()

	if err := awaitReady(read, 5*time.Second); err == nil {
		t.Fatal("expected awaitReady to reject an unexpected token")
	}
}

func TestAwaitReadyFailsWhenRelayDiesSilently(t *testing.T) {
	read, write, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	defer read.Close()
	write.Close()

	err = awaitReady(read, 5*time.Second)
	if err == nil {
		t.Fatal("expected awaitReady to fail when the pipe closes without a token")
	}
	if !strings.Contains(err.Error(), "before reporting ready") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestAwaitReadyTimesOut(t *testing.T) {
	read, write, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	defer read.Close()
	defer write.Close()

	err = awaitReady(read, 50*time.Millisecond)
	if err == nil || !strings.Contains(err.Error(), "did not report ready") {
		t.Fatalf("expected a timeout error, got %v", err)
	}
}

func TestAwaitReadyAcceptsToken(t *testing.T) {
	read, write, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	defer read.Close()
	go func() {
		_, _ = write.WriteString(ReadyToken + "\n")
		write.Close()
	}()
	if err := awaitReady(read, 5*time.Second); err != nil {
		t.Fatalf("awaitReady: %v", err)
	}
}

func TestResolveRealInitRejectsUnsafeBinaries(t *testing.T) {
	dir := t.TempDir()

	if _, err := resolveRealInit(filepath.Join(dir, "missing")); err == nil {
		t.Fatal("expected a missing init binary to fail")
	}

	target := filepath.Join(dir, "vminitd.apple")
	if err := os.WriteFile(target, []byte("#!/bin/true\n"), 0o755); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := resolveRealInit(target); err != nil {
		t.Fatalf("expected a well-formed init binary to be accepted: %v", err)
	}

	link := filepath.Join(dir, "linked")
	if err := os.Symlink(target, link); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	if _, err := resolveRealInit(link); err == nil {
		t.Fatal("expected a symlinked init binary to be rejected")
	}

	notExecutable := filepath.Join(dir, "plain")
	if err := os.WriteFile(notExecutable, []byte("x"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := resolveRealInit(notExecutable); err == nil {
		t.Fatal("expected a non-executable init binary to be rejected")
	}

	worldWritable := filepath.Join(dir, "loose")
	if err := os.WriteFile(worldWritable, []byte("x"), 0o755); err != nil {
		t.Fatalf("write: %v", err)
	}
	// Written through the umask, so the loose bits are set explicitly.
	if err := os.Chmod(worldWritable, 0o777); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	if _, err := resolveRealInit(worldWritable); err == nil {
		t.Fatal("expected a world-writable init binary to be rejected")
	}

	directory := filepath.Join(dir, "sub")
	if err := os.Mkdir(directory, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if _, err := resolveRealInit(directory); err == nil {
		t.Fatal("expected a directory to be rejected")
	}
}

// shortTempDir keeps socket paths inside the 104-byte sun_path limit; the
// default t.TempDir() path on macOS is long enough to overflow it, which is the
// same constraint the host side enforces up front.
func shortTempDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "awfrelay")
	if err != nil {
		t.Fatalf("temp dir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

func newTestRelay(t *testing.T, socketPath string) *relay {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	capability := Capability{
		ID:         "test",
		SocketName: filepath.Base(socketPath),
		GuestPort:  listener.Addr().(*net.TCPAddr).Port,
	}
	r := &relay{capability: capability, listener: listener, socketPath: socketPath}
	go r.serve()
	return r
}

func TestSignalReadyRequiresAnInheritedPipe(t *testing.T) {
	if err := signalReady(nil); err == nil {
		t.Fatal("expected signalReady to fail without an inherited pipe")
	}
}
