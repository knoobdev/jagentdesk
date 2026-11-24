// Command tsnet-bridge exposes the daemon's /ws endpoint on a Tailscale
// tailnet. It is a raw TCP forwarder: the tailnet listener accepts TCP
// connections (clients dial ws://<dnsName>:<tailnetPort>/ws) and pipes bytes
// to the Node-side local ingress on 127.0.0.1:<localPort>, which performs the
// HTTP upgrade and WebSocket framing. The bridge terminates nothing at the
// WebSocket level.
//
// The Node side waits for the single stdout handshake line before advertising
// the tailnet address:
//
//	TSNET_READY <dnsName>
//
// Before TSNET_READY, the bridge prints exactly one line describing the
// loopback SOCKS5 proxy of the tsnet node (spec 33.2 / ADR-0044):
//
//	TSNET_SOCKS5 <addr> <proxyCred>
//
// The SOCKS5 user is "tsnet" and proxyCred is the per-run password; localAPICred
// is never printed. A Loopback failure must not kill inbound serving, so it
// prints `TSNET_SOCKS5_ERROR <message>` and continues.
//
// Startup failures print TSNET_ERROR <message> and exit non-zero.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"tailscale.com/tsnet"
)

func main() {
	tailnetPort := flag.Int("tailnet-port", 0, "tailnet port clients dial (required)")
	localPort := flag.Int("local-port", 0, "loopback port of the Node /ws ingress (required)")
	hostname := flag.String("hostname", "", "tsnet hostname (default: os.Hostname())")
	useTLS := flag.Bool("tls", false, "use ListenTLS so clients can dial wss")
	stateDir := flag.String("state-dir", "", "tsnet state directory (default: TS_STATE_DIR)")
	flag.Parse()

	if *tailnetPort <= 0 || *localPort <= 0 {
		fail("--tailnet-port and --local-port must be positive integers")
	}

	name := *hostname
	if name == "" {
		name, _ = os.Hostname()
	}

	dir := *stateDir
	if dir == "" {
		dir = os.Getenv("TS_STATE_DIR")
	}

	emitLoginURL := func(message string) {
		if index := strings.Index(message, "https://login.tailscale.com/"); index >= 0 {
			url := strings.Fields(message[index:])[0]
			fmt.Printf("TSNET_LOGIN_URL %s\n", url)
		}
	}
	logf := func(format string, args ...any) {
		message := fmt.Sprintf(format, args...)
		emitLoginURL(message)
		log.Print(message)
	}
	if os.Getenv("TS_LOG") == "off" {
		logf = func(format string, args ...any) {
			emitLoginURL(fmt.Sprintf(format, args...))
		}
	}

	srv := &tsnet.Server{
		Hostname: name,
		AuthKey:  os.Getenv("TS_AUTHKEY"),
		Dir:      dir,
		Logf:     logf,
		UserLogf: func(format string, args ...any) {
			message := fmt.Sprintf(format, args...)
			emitLoginURL(message)
		},
		Ephemeral: false,
	}

	// Interactive browser authentication can take longer than a minute. Keep
	// the bridge alive while the user completes login; once authenticated,
	// srv.Up returns and the tailnet listener becomes ready.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	if _, err := srv.Up(ctx); err != nil {
		fail(fmt.Sprintf("tsnet up: %v", err))
	}

	// Loopback SOCKS5 (spec 33.2): the daemon reaches tailnet targets through this
	// proxy. A failure only removes the outbound path; inbound serving continues.
	socksAddr, proxyCred, _, loopbackErr := srv.Loopback()
	if loopbackErr != nil {
		fmt.Printf("TSNET_SOCKS5_ERROR %s\n", singleLine(loopbackErr.Error()))
	} else {
		fmt.Printf("TSNET_SOCKS5 %s %s\n", socksAddr, proxyCred)
	}

	addr := fmt.Sprintf(":%d", *tailnetPort)
	ln, err := listen(srv, *useTLS, addr)
	if err != nil {
		fail(fmt.Sprintf("listen on tailnet: %v", err))
	}
	defer ln.Close()

	lc, err := srv.LocalClient()
	if err != nil {
		fail(fmt.Sprintf("tailnet local client: %v", err))
	}
	statusCtx, statusCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer statusCancel()
	status, err := lc.Status(statusCtx)
	if err != nil {
		fail(fmt.Sprintf("tailnet status: %v", err))
	}
	dnsName := strings.TrimSuffix(status.Self.DNSName, ".")
	if dnsName == "" {
		dnsName = name
	}

	fmt.Printf("TSNET_READY %s\n", dnsName)

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sigCh
		ln.Close()
		srv.Close()
		os.Exit(0)
	}()

	target, _ := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", *localPort))
	proxy := httputil.NewSingleHostReverseProxy(target)
	director := proxy.Director
	proxy.Director = func(request *http.Request) {
		director(request)
		request.Header.Set("X-JAgentDesk-Bridge", os.Getenv("JAGENTDESK_TSNET_INGRESS_TOKEN"))
		request.Header.Set("X-JAgentDesk-Node", request.Context().Value(nodeContextKey{}).(string))
	}
	verified := &peerListener{Listener: ln, verify: func(conn net.Conn) (string, error) {
		lookupCtx, lookupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer lookupCancel()
		who, err := lc.WhoIs(lookupCtx, conn.RemoteAddr().String())
		if err != nil || who == nil || who.Node == nil {
			return "", fmt.Errorf("not_a_tailnet_peer")
		}
		if who.Node.Sharer != 0 || who.Node.User != status.Self.UserID {
			login := ""
			if who.UserProfile != nil {
				login = who.UserProfile.LoginName
			}
			encoded, _ := json.Marshal(login)
			log.Printf("wrong_tailnet_account login=%s", encoded)
			return "", fmt.Errorf("wrong_tailnet_account")
		}
		return string(who.Node.StableID), nil
	}}
	httpServer := &http.Server{Handler: proxy, ReadHeaderTimeout: 15 * time.Second,
		ConnContext: func(ctx context.Context, conn net.Conn) context.Context {
			return context.WithValue(ctx, nodeContextKey{}, conn.(*peerConn).nodeID)
		},
	}
	if err := httpServer.Serve(verified); err != nil && !errors.Is(err, net.ErrClosed) && !errors.Is(err, http.ErrServerClosed) {
		log.Printf("tailnet serve: %v", err)
	}

}

// singleLine flattens an error message onto one stdout line.
func singleLine(message string) string {
	return strings.Join(strings.Fields(message), " ")
}

func listen(srv *tsnet.Server, useTLS bool, addr string) (net.Listener, error) {
	if useTLS {
		return srv.ListenTLS("tcp", addr)
	}
	return srv.Listen("tcp", addr)
}

// WhoIs runs before the HTTP server reads application bytes.
type nodeContextKey struct{}
type peerConn struct {
	net.Conn
	nodeID string
}
type peerListener struct {
	net.Listener
	verify func(net.Conn) (string, error)
}

func (listener *peerListener) Accept() (net.Conn, error) {
	for {
		conn, err := listener.Listener.Accept()
		if err != nil {
			return nil, err
		}
		nodeID, err := listener.verify(conn)
		if err != nil || nodeID == "" {
			conn.Close()
			log.Printf("tailnet connection rejected: %v", err)
			continue
		}
		return &peerConn{Conn: conn, nodeID: nodeID}, nil
	}
}

func fail(message string) {
	fmt.Printf("TSNET_ERROR %s\n", message)
	os.Exit(1)
}
