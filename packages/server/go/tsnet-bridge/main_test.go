package main

import (
	"fmt"
	"net"
	"sync/atomic"
	"testing"
	"time"
)

func TestStalledWhoIsDoesNotBlockNextPeer(t *testing.T) {
	underlying, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	stalled := make(chan struct{})
	release := make(chan struct{})
	defer close(release)
	var lookups atomic.Int32
	listener := newPeerListener(underlying, func(conn net.Conn) (string, error) {
		if lookups.Add(1) == 1 {
			close(stalled)
			<-release
			return "", fmt.Errorf("not_a_tailnet_peer LoginName=\"\"")
		}
		return "second-peer", nil
	})
	defer listener.Close()
	peer1, err := net.Dial("tcp", underlying.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer peer1.Close()
	<-stalled
	peer2, err := net.Dial("tcp", underlying.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer peer2.Close()
	accepted := make(chan net.Conn, 1)
	go func() { conn, _ := listener.Accept(); accepted <- conn }()
	select {
	case conn := <-accepted:
		if conn == nil {
			t.Fatal("listener closed")
		}
		defer conn.Close()
		if conn.(*peerConn).nodeID != "second-peer" {
			t.Fatal("unverified peer returned")
		}
	case <-time.After(time.Second):
		t.Fatal("stalled WhoIs delayed second peer")
	}
	// No HTTP/application reader has consumed anything from the rejected connection.
	if err := peer1.SetReadDeadline(time.Now().Add(20 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	if n, err := peer1.Read(make([]byte, 1)); n != 0 || err == nil {
		t.Fatal("unexpected application response")
	}
}
