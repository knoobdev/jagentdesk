#!/usr/bin/env bash
# Starts the Docker-enabled sshd the S7/S8 and modules e2e suites run against
# (JAD_SSH_DOCKER_E2E=1): lscr.io/linuxserver/openssh-server with the host Docker socket
# bind-mounted at /var/run/docker.sock, user `jad` in the socket's group (so `docker ps` on
# the server works), and TCP forwarding enabled (the image disables it).
#   bash start-docker-test-sshd.sh                       # jad-sshd-wire on 127.0.0.1:2237
#   JAD_DOCKER_SSHD_NAME=jad-a-wire JAD_DOCKER_SSHD_PORT=2237 bash start-docker-test-sshd.sh
# Remove it afterwards with: docker rm -f "$JAD_DOCKER_SSHD_NAME"
set -euo pipefail
NAME="${JAD_DOCKER_SSHD_NAME:-jad-sshd-wire}"
PORT="${JAD_DOCKER_SSHD_PORT:-2237}"
if ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
  docker run -d --name "$NAME" -p "127.0.0.1:$PORT:2222" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -e PASSWORD_ACCESS=true -e USER_NAME=jad -e USER_PASSWORD=jadtest -e SUDO_ACCESS=true \
    lscr.io/linuxserver/openssh-server >/dev/null
  until docker exec "$NAME" test -f /config/sshd/sshd_config; do sleep 1; done
  sleep 2
fi
# The socket's group inside the container (root on Docker Desktop, `docker` on Linux hosts).
docker exec "$NAME" sh -c '
  gid=$(stat -c %g /var/run/docker.sock)
  group=$(getent group "$gid" | cut -d: -f1)
  if [ -z "$group" ]; then group=dockersock; addgroup -g "$gid" "$group"; fi
  addgroup jad "$group" 2>/dev/null || true
  command -v docker >/dev/null || apk add --no-cache docker-cli >/dev/null
  sed -i "s/^AllowTcpForwarding no/AllowTcpForwarding yes/" /config/sshd/sshd_config
'
docker exec "$NAME" /command/s6-svc -r /run/service/svc-openssh-server
sleep 2
