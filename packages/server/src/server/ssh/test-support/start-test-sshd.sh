#!/usr/bin/env bash
# Starts the real sshd the SSH module integration tests connect to (127.0.0.1:2231, jad/jadtest)
# and enables TCP forwarding, which the linuxserver image disables by default.
# Remove it afterwards with: docker rm -f jad-sshd-mod
set -euo pipefail
NAME="${JAD_TEST_SSHD_NAME:-jad-sshd-mod}"
PORT="${JAD_TEST_SSHD_PORT:-2231}"
if ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
  docker run -d --name "$NAME" -p "$PORT:2222" -e PASSWORD_ACCESS=true -e USER_NAME=jad \
    -e USER_PASSWORD=jadtest -e SUDO_ACCESS=true lscr.io/linuxserver/openssh-server >/dev/null
  until docker exec "$NAME" test -f /config/sshd/sshd_config; do sleep 1; done
  sleep 2
fi
docker exec "$NAME" sh -c "sed -i 's/^AllowTcpForwarding no/AllowTcpForwarding yes/; s/^GatewayPorts no/GatewayPorts clientspecified/' /config/sshd/sshd_config"
docker exec "$NAME" /command/s6-svc -r /run/service/svc-openssh-server
sleep 2
