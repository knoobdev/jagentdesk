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
// Startup failures print TSNET_ERROR <message> and exit non-zero.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
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
		Hostname:  name,
		AuthKey:   os.Getenv("TS_AUTHKEY"),
		Dir:       dir,
		Logf:      logf,
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

	for {
		conn, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			log.Printf("accept: %v", err)
			continue
		}
		go forward(conn, *localPort)
	}
}

func listen(srv *tsnet.Server, useTLS bool, addr string) (net.Listener, error) {
	if useTLS {
		return srv.ListenTLS("tcp", addr)
	}
	return srv.Listen("tcp", addr)
}

// forward pipes conn to the Node ingress on 127.0.0.1:localPort and closes
// both sides when either direction finishes.
func forward(conn net.Conn, localPort int) {
	local, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", localPort))
	if err != nil {
		log.Printf("dial local ingress: %v", err)
		conn.Close()
		return
	}

	done := make(chan struct{}, 1)
	go func() {
		io.Copy(local, conn)
		done <- struct{}{}
	}()
	go func() {
		io.Copy(conn, local)
		done <- struct{}{}
	}()
	<-done
	conn.Close()
	local.Close()
}

func fail(message string) {
	fmt.Printf("TSNET_ERROR %s\n", message)
	os.Exit(1)
}
