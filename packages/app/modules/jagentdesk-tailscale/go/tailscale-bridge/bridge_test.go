package tailscalebridge

import (
	"context"
	"errors"
	"io"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"tailscale.com/tsnet"
)

// newTestBridge builds a bridge whose tailnet dial is a fake, so listener
// recovery and revive run without a real tailnet node. The returned channel
// receives the far end of every fake dial so tests can assert forwarding.
func newTestBridge(t *testing.T) (*Bridge, chan net.Conn) {
	t.Helper()
	b := &Bridge{closed: make(chan struct{})}
	remotes := make(chan net.Conn, 8)
	b.dial = func(ctx context.Context, network, address string) (net.Conn, error) {
		inside, outside := net.Pipe()
		remotes <- outside
		return inside, nil
	}
	t.Cleanup(func() {
		b.mu.Lock()
		ln := b.listener
		b.mu.Unlock()
		if ln != nil {
			_ = ln.Close()
		}
		close(b.closed)
	})
	return b, remotes
}

// dialLoopbackRetry dials addr until it succeeds or the deadline passes; the
// accept loop needs one backoff sleep before the reclaimed port is re-opened.
func dialLoopbackRetry(t *testing.T, addr string, deadline time.Duration) net.Conn {
	t.Helper()
	var d net.Dialer
	deadlineAt := time.Now().Add(deadline)
	for {
		conn, err := d.Dial("tcp", addr)
		if err == nil {
			return conn
		}
		if time.Now().After(deadlineAt) {
			t.Fatalf("dial %s after deadline: %v", addr, err)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func expectForwarded(t *testing.T, remotes chan net.Conn, conn net.Conn, payload string) {
	t.Helper()
	var remote net.Conn
	select {
	case remote = <-remotes:
	case <-time.After(5 * time.Second):
		t.Fatal("fake dialer was never called")
	}
	if _, err := conn.Write([]byte(payload)); err != nil {
		t.Fatalf("write to loopback conn: %v", err)
	}
	buf := make([]byte, len(payload))
	_ = remote.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.ReadFull(remote, buf); err != nil {
		t.Fatalf("read forwarded payload: %v", err)
	}
	if string(buf) != payload {
		t.Fatalf("forwarded payload = %q, want %q", buf, payload)
	}
	_ = conn.Close()
	_ = remote.Close()
}

// Closing the listener from outside (what iOS does to a suspended app's
// sockets) must not spin the accept loop: the same 127.0.0.1 port is
// re-opened and a fresh connection is forwarded to the dialer.
func TestAcceptLoopReopensClosedListener(t *testing.T) {
	b, remotes := newTestBridge(t)
	if err := b.startProxyLocked("tailnet-target:6768"); err != nil {
		t.Fatalf("startProxyLocked: %v", err)
	}
	addr := b.LocalAddress()
	if addr == "" {
		t.Fatal("no loopback address")
	}

	b.mu.Lock()
	ln := b.listener
	b.mu.Unlock()
	if err := ln.Close(); err != nil {
		t.Fatalf("external listener close: %v", err)
	}

	conn := dialLoopbackRetry(t, addr, 10*time.Second)
	expectForwarded(t, remotes, conn, "ping")
	if got := b.LocalAddress(); got != addr {
		t.Fatalf("listener recovered on %q, want same port %q", got, addr)
	}
}

// Revive must re-open the loopback listener on the same port and return it.
func TestReviveReopensSamePort(t *testing.T) {
	b, remotes := newTestBridge(t)
	if err := b.startProxyLocked("tailnet-target:6768"); err != nil {
		t.Fatalf("startProxyLocked: %v", err)
	}
	origAddr := b.LocalAddress()

	b.mu.Lock()
	ln := b.listener
	b.mu.Unlock()
	_ = ln.Close()

	addr, err := b.Revive("tailnet-target:6768")
	if err != nil {
		t.Fatalf("Revive: %v", err)
	}
	if addr != origAddr {
		t.Fatalf("Revive address = %q, want the original %q", addr, origAddr)
	}

	// Revive's own connectivity check consumed one fake dial; discard its
	// pipe end before asserting on real forwarding.
	checkRemote := <-remotes
	_ = checkRemote.Close()

	conn := dialLoopbackRetry(t, addr, 5*time.Second)
	expectForwarded(t, remotes, conn, "ping")
}

// While Revive is blocked in a (slow) reachability dial, synchronous
// Proxy()/LocalAddress() calls — which run on the JS thread — must return
// immediately: they must never wait on a dial or node restart.
func TestReviveDoesNotBlockProxyWhileDialing(t *testing.T) {
	b, _ := newTestBridge(t)
	// Proxy() refuses to run without a node; the fake dial seam keeps the
	// zero-value server from being touched.
	b.server = &tsnet.Server{}
	release := make(chan struct{})
	b.dial = func(ctx context.Context, network, address string) (net.Conn, error) {
		<-release
		return nil, errors.New("daemon unreachable")
	}
	if err := b.startProxyLocked("tailnet-target:6768"); err != nil {
		t.Fatalf("startProxyLocked: %v", err)
	}
	addr := b.LocalAddress()

	reviveDone := make(chan error, 1)
	go func() {
		_, err := b.Revive("tailnet-target:6768")
		reviveDone <- err
	}()
	time.Sleep(50 * time.Millisecond) // let the revive enter the slow dial

	start := time.Now()
	if err := b.Proxy("tailnet-target:6768"); err != nil {
		t.Fatalf("Proxy during revive: %v", err)
	}
	if got := b.LocalAddress(); got != addr {
		t.Fatalf("LocalAddress during revive = %q, want %q", got, addr)
	}
	if elapsed := time.Since(start); elapsed > 100*time.Millisecond {
		t.Fatalf("Proxy/LocalAddress took %v during revive, want < 100ms", elapsed)
	}
	close(release)
	// The daemon stays unreachable and the state dir is unset (the node
	// restart fails), so the revive still returns the address with nil error.
	if err := <-reviveDone; err != nil {
		t.Fatalf("Revive with unreachable daemon: %v", err)
	}
	if got := b.LocalAddress(); got != addr {
		t.Fatalf("listener address after revive = %q, want %q", got, addr)
	}
}

// When the daemon is not reachable through the tailnet, Revive restarts the
// node from the saved state directory and then re-dials.
func TestReviveRestartsNodeWhenDialFails(t *testing.T) {
	b, _ := newTestBridge(t)
	baseDial := b.dial
	var dialCalls int32
	b.dial = func(ctx context.Context, network, address string) (net.Conn, error) {
		if atomic.AddInt32(&dialCalls, 1) == 1 {
			return nil, errors.New("tsnet node is dead")
		}
		return baseDial(ctx, network, address)
	}
	var restarts int32
	b.restartNode = func() error {
		atomic.AddInt32(&restarts, 1)
		return nil
	}
	if err := b.startProxyLocked("tailnet-target:6768"); err != nil {
		t.Fatalf("startProxyLocked: %v", err)
	}
	addr := b.LocalAddress()

	got, err := b.Revive("tailnet-target:6768")
	if err != nil {
		t.Fatalf("Revive: %v", err)
	}
	if got != addr {
		t.Fatalf("Revive address = %q, want %q", got, addr)
	}
	if restarts != 1 {
		t.Fatalf("node restarts = %d, want 1", restarts)
	}
}
