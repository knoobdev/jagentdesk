# Running JAgentDesk in Docker

The image in [`docker/base/`](../docker/base/) runs the daemon on a server, VM, NAS or homelab box
and serves the bundled browser web UI from the same origin. This page is about running the daemon
in a container; the Docker cockpit inside the app is the `docker` [built-in](builtin-plugins.md).

## What the image does

- Builds `@jagentdesk/server` and `@jagentdesk/cli` from workspace tarballs of the checked-out
  source.
- Runs the daemon as the non-root `jagentdesk` user (uid/gid `1000:1000`) under `tini`.
- Listens on `0.0.0.0:6767` and sets `JAGENTDESK_WEB_UI_ENABLED=true`.
- Stores daemon state and agent credentials under `/home/jagentdesk`.
- Ships no agent CLIs.
- Health-checks `GET /api/health`.

Open the container's HTTP origin, for example `http://localhost:6767`. The served app gets a
same-origin connection hint and connects back to that daemon. Static UI files load without auth;
the API and WebSocket require `JAGENTDESK_PASSWORD` when one is set.

## Build the image

No image is published. Build it from the repository root:

```bash
docker build -f docker/base/Dockerfile -t jagentdesk:local .
```

`--build-arg JAGENTDESK_VERSION=<version>` makes the build fail unless the root `package.json` has
that version.

## Run

```bash
docker run -d --name jagentdesk \
  -p 6767:6767 \
  -e JAGENTDESK_PASSWORD=change-me \
  -v "$PWD/jagentdesk-home:/home/jagentdesk" \
  -v "$PWD:/workspace" \
  jagentdesk:local
```

Open `http://localhost:6767`. If you set `JAGENTDESK_PASSWORD`, enter the same password when you
add the direct connection in the web UI or another client.

For Compose, start from [`docker/docker-compose.example.yml`](../docker/docker-compose.example.yml)
and set `image:` to the tag you built.

## Add agents

Create a child image with the agent CLIs you use. An example is in
[`docker/Dockerfile.agents.example`](../docker/Dockerfile.agents.example):

```Dockerfile
FROM jagentdesk:local

USER root
RUN npm install -g @anthropic-ai/claude-code @openai/codex opencode-ai
```

Leave the child image user as root. The entrypoint uses root only to prepare mounted directories,
then drops the daemon and the agents it launches to `jagentdesk`.

Sign agents in once inside the container, or mount their credentials:

```bash
docker exec -it --user jagentdesk jagentdesk claude
docker exec -it --user jagentdesk jagentdesk codex
```

Provider variables such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_BASE_URL` or
`OPENAI_BASE_URL` passed with `docker run -e` or Compose `environment` reach launched agents.

## Volumes and defaults

| Mount              | Purpose                                                                         |
| ------------------ | ------------------------------------------------------------------------------- |
| `/home/jagentdesk` | Daemon state in `.jagentdesk`, plus agent config such as `.claude` and `.codex` |
| `/workspace`       | Code the daemon and its agents can read and write                               |

| Variable                | Default                        |
| ----------------------- | ------------------------------ |
| `HOME`                  | `/home/jagentdesk`             |
| `JAGENTDESK_HOME`       | `/home/jagentdesk/.jagentdesk` |
| `JAGENTDESK_LISTEN`     | `0.0.0.0:6767`                 |
| `JAGENTDESK_LOG_FORMAT` | `json`                         |
| `CLAUDE_CONFIG_DIR`     | `/home/jagentdesk/.claude`     |
| `CODEX_HOME`            | `/home/jagentdesk/.codex`      |

On Linux bind mounts, the container user must be able to write the host directories. Change their
ownership to `1000:1000`, or run the container with `--user` / Compose `user:`.

## Reverse proxies

Forward HTTP requests and WebSocket upgrades to the same daemon port.

```caddy
jagentdesk.example.com {
  reverse_proxy 127.0.0.1:6767
}
```

```nginx
server {
    listen 443 ssl;
    server_name jagentdesk.example.com;

    location / {
        proxy_pass http://127.0.0.1:6767;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

When you reach the daemon by DNS name, add the name to `JAGENTDESK_HOSTNAMES` (comma-separated; a
leading dot matches subdomains). IPs and `localhost` are allowed by default. Forwarded-header trust
(`trustedProxies`) is described in [Service proxy](service-proxy.md#dns-and-reverse-proxy-setup).

## Security

- Set `JAGENTDESK_PASSWORD` for any published port.
- Terminate HTTPS at the reverse proxy for browser access.
- To reach the daemon from phones or untrusted networks without publishing the port, use the
  embedded Tailscale node or the encrypted relay. See [Relay](relay.md).
- The container is the isolation boundary. Agents can read and write everything mounted at
  `/workspace` and every credential in `/home/jagentdesk`.

See [SECURITY.md](../SECURITY.md) for the trust model.

## Troubleshooting

- **The web UI loads but cannot connect:** add a direct connection with the `JAGENTDESK_PASSWORD`
  value.
- **403 Host not allowed:** add the DNS name to `JAGENTDESK_HOSTNAMES`.
- **Provider not available:** install that agent CLI in a child image.
- **Permission errors in `/workspace`:** make the mount writable by `1000:1000`, or run as the host
  uid/gid.
- **Logs:** `docker logs jagentdesk`, or `/home/jagentdesk/.jagentdesk/daemon.log` in the
  container.
