package tailscalebridge

import (
	"io"
	"net"
)

func proxy(left, right net.Conn) {
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(left, right); done <- struct{}{} }()
	go func() { _, _ = io.Copy(right, left); done <- struct{}{} }()
	<-done
	_ = left.Close()
	_ = right.Close()
}
