# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:22-bookworm-slim
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS source-pack

ARG JAGENTDESK_VERSION

ENV ONNXRUNTIME_NODE_INSTALL=skip

WORKDIR /tmp/jagentdesk-src
COPY . .

RUN set -eux; \
    if [ -n "${JAGENTDESK_VERSION:-}" ]; then \
      test "$(node -p "require('./package.json').version")" = "${JAGENTDESK_VERSION}"; \
    fi; \
    node -e 'const fs=require("node:fs"); const pkg=JSON.parse(fs.readFileSync("package.json","utf8")); delete pkg.scripts.prepare; fs.writeFileSync("package.json", `${JSON.stringify(pkg)}\n`);'; \
    npm ci

RUN set -eux; \
    mkdir -p /tmp/jagentdesk-packs; \
    npm pack --workspace=@jagentdesk/highlight --pack-destination /tmp/jagentdesk-packs; \
    npm pack --workspace=@jagentdesk/protocol --pack-destination /tmp/jagentdesk-packs; \
    npm pack --workspace=@jagentdesk/client --pack-destination /tmp/jagentdesk-packs; \
    npm pack --workspace=@jagentdesk/server --pack-destination /tmp/jagentdesk-packs; \
    npm pack --workspace=@jagentdesk/cli --pack-destination /tmp/jagentdesk-packs

FROM ${NODE_IMAGE}

ENV HOME=/home/jagentdesk \
    JAGENTDESK_HOME=/home/jagentdesk/.jagentdesk \
    JAGENTDESK_LISTEN=0.0.0.0:6767 \
    JAGENTDESK_WEB_UI_ENABLED=true \
    JAGENTDESK_LOG_FORMAT=json \
    JAGENTDESK_LOG_LEVEL=info \
    CLAUDE_CONFIG_DIR=/home/jagentdesk/.claude \
    CODEX_HOME=/home/jagentdesk/.codex \
    XDG_CONFIG_HOME=/home/jagentdesk/.config \
    XDG_DATA_HOME=/home/jagentdesk/.local/share \
    XDG_STATE_HOME=/home/jagentdesk/.local/state \
    XDG_CACHE_HOME=/home/jagentdesk/.cache \
    ONNXRUNTIME_NODE_INSTALL=skip

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      git \
      gosu \
      lbzip2 \
      openssh-client \
      procps \
      tini; \
    rm -rf /var/lib/apt/lists/*

COPY --from=source-pack /tmp/jagentdesk-packs /tmp/jagentdesk-packs
RUN set -eux; \
	npm install -g /tmp/jagentdesk-packs/*.tgz; \
    rm -rf /tmp/jagentdesk-packs; \
    npm cache clean --force; \
    server_entry="$(npm root -g)/@jagentdesk/server/dist/scripts/supervisor-entrypoint.js"; \
    test -f "$server_entry"; \
    printf '%s\n' "$server_entry" > /etc/jagentdesk-server-entry; \
    node --check "$server_entry"

RUN set -eux; \
    existing_group="$(getent group 1000 | cut -d: -f1 || true)"; \
    if [ -n "$existing_group" ] && [ "$existing_group" != "jagentdesk" ]; then \
      groupmod --new-name jagentdesk "$existing_group"; \
    elif [ -z "$existing_group" ]; then \
      groupadd --gid 1000 jagentdesk; \
    fi; \
    existing_user="$(getent passwd 1000 | cut -d: -f1 || true)"; \
    if [ -n "$existing_user" ] && [ "$existing_user" != "jagentdesk" ]; then \
      usermod --login jagentdesk --gid jagentdesk --home /home/jagentdesk --shell /bin/bash "$existing_user"; \
    elif [ -z "$existing_user" ]; then \
      useradd --uid 1000 --gid jagentdesk --create-home --home-dir /home/jagentdesk --shell /bin/bash jagentdesk; \
    fi; \
    mkdir -p \
      /workspace \
      "$JAGENTDESK_HOME" \
      "$CLAUDE_CONFIG_DIR" \
      "$CODEX_HOME" \
      "$XDG_CONFIG_HOME" \
      "$XDG_DATA_HOME" \
      "$XDG_STATE_HOME" \
      "$XDG_CACHE_HOME"; \
    chown -R jagentdesk:jagentdesk /home/jagentdesk /workspace

COPY docker/base/rootfs/ /
RUN chmod +x /usr/local/bin/jagentdesk-docker-entrypoint

WORKDIR /workspace

EXPOSE 6767
VOLUME ["/home/jagentdesk"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "const listen=process.env.JAGENTDESK_LISTEN||'0.0.0.0:6767'; const m=listen.match(/:(\\d+)$/); const port=m?Number(m[1]):6767; require('http').get({hostname:'127.0.0.1',port,path:'/api/health'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/jagentdesk-docker-entrypoint"]
