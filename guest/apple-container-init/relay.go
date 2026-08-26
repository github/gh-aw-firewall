package main

// Guest-side relay: loopback TCP in, published Unix socket out.
//
// This is the mirror image of the host relay in
// src/apple-container/transport-relay.ts and is just as deliberately dumb. It
// performs no protocol parsing of any kind — no HTTP framing, no CONNECT
// handling, no header inspection — because the bytes it moves are produced by
// the workload, which is the least trusted thing in the system. It is a byte
// pump with fixed bounds:
//
//   - listeners are bound to 127.0.0.1 only, so nothing outside the VM can
//     reach them (there is nothing outside the VM to reach them with: the guest
//     has no NIC);
//   - a per-capability concurrent connection cap, enforced by dropping excess
//     connections rather than queueing them;
//   - a dial timeout on the Unix socket;
//   - an idle timeout refreshed on every successful read or write;
//   - a fixed 32 KiB copy buffer per direction, so memory is bounded by
//     connections x buffers and nothing accumulates.
//
// A capability whose socket was not published simply fails to dial and the
// connection is closed with no data written. There is no retry and no fallback.

import (
	"errors"
	"net"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

const (
	maxConnectionsPerCapability = 64
	dialTimeout                 = 5 * time.Second
	idleTimeout                 = 300 * time.Second
	copyBufferBytes             = 32 * 1024
)

// halfCloser is implemented by both *net.TCPConn and *net.UnixConn. Preserving
// half-close in both directions is required for HTTP: a client that shuts down
// its write side after sending a request must still receive the full response.
type halfCloser interface {
	net.Conn
	CloseWrite() error
}

type relay struct {
	capability Capability
	// socketPath is resolved once at bind time from the compiled-in contract.
	// It is a field rather than a call so tests can point a relay at a
	// temporary socket without weakening the production path, which always
	// uses Capability.SocketPath().
	socketPath string
	listener   net.Listener
	active     atomic.Int32
	wg         sync.WaitGroup
}

// bindRelays binds every allowlisted loopback port.
//
// It is all-or-nothing: a single bind failure closes the listeners already
// bound and returns an error, so the shim never execs the real init with a
// partial capability set.
func bindRelays(capabilities []Capability) ([]*relay, error) {
	relays := make([]*relay, 0, len(capabilities))
	for _, capability := range capabilities {
		listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(capability.GuestPort)))
		if err != nil {
			for _, bound := range relays {
				_ = bound.listener.Close()
			}
			return nil, errors.New("bind 127.0.0.1:" + strconv.Itoa(capability.GuestPort) + ": " + err.Error())
		}
		relays = append(relays, &relay{
			capability: capability,
			socketPath: capability.SocketPath(),
			listener:   listener,
		})
	}
	return relays, nil
}

// serve accepts until the listener is closed.
func (r *relay) serve() {
	for {
		conn, err := r.listener.Accept()
		if err != nil {
			return
		}
		// Reserve the slot with a single atomic increment and give it back on
		// overflow, so concurrent accepts can never exceed the cap.
		if r.active.Add(1) > maxConnectionsPerCapability {
			r.active.Add(-1)
			_ = conn.Close()
			continue
		}
		r.wg.Add(1)
		go func() {
			defer r.wg.Done()
			defer r.active.Add(-1)
			r.handle(conn)
		}()
	}
}

func (r *relay) close() {
	_ = r.listener.Close()
	r.wg.Wait()
}

func (r *relay) handle(conn net.Conn) {
	defer conn.Close()

	upstream, err := net.DialTimeout("unix", r.socketPath, dialTimeout)
	if err != nil {
		// Fail closed: the workload sees an immediately closed connection, never
		// a fallback path.
		return
	}
	defer upstream.Close()

	guest, guestOK := conn.(halfCloser)
	host, hostOK := upstream.(halfCloser)
	if !guestOK || !hostOK {
		return
	}
	forward(guest, host)
}

// forward copies both directions and returns once both have finished.
func forward(guest, host halfCloser) {
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		copyBounded(host, guest)
		_ = host.CloseWrite()
	}()
	go func() {
		defer wg.Done()
		copyBounded(guest, host)
		_ = guest.CloseWrite()
	}()
	wg.Wait()
}

// copyBounded moves bytes with a fixed buffer and an idle deadline that is
// refreshed only when progress is made, so a stalled peer is dropped instead of
// held open forever.
func copyBounded(dst, src net.Conn) {
	buffer := make([]byte, copyBufferBytes)
	for {
		if err := src.SetReadDeadline(time.Now().Add(idleTimeout)); err != nil {
			return
		}
		read, readErr := src.Read(buffer)
		if read > 0 {
			if err := dst.SetWriteDeadline(time.Now().Add(idleTimeout)); err != nil {
				return
			}
			if _, writeErr := dst.Write(buffer[:read]); writeErr != nil {
				return
			}
		}
		if readErr != nil {
			// Any error, including a clean EOF and an idle-deadline expiry, ends
			// this direction; the caller then half-closes the peer. Nothing is
			// retried.
			return
		}
	}
}

// readyPipe returns the inherited readiness pipe (fd 3).
func readyPipe() *os.File {
	return os.NewFile(ReadyFD, "awf-relay-ready")
}

// signalReady tells the parent shim that every listener is bound. Writing the
// token is the only thing that lets the boot proceed, so a failure here must
// abort the relay rather than be ignored.
func signalReady(pipe *os.File) error {
	if pipe == nil {
		return errors.New("ready pipe (fd 3) was not inherited")
	}
	defer pipe.Close()
	if _, err := pipe.WriteString(ReadyToken + "\n"); err != nil {
		return err
	}
	return nil
}
