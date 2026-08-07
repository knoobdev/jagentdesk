#!/usr/bin/env bash

default_dev_jagentdesk_root() {
  git rev-parse --show-toplevel 2>/dev/null || pwd
}

copy_json_tree() {
  local source_dir="$1"
  local target_dir="$2"

  if [ ! -d "$source_dir" ]; then
    return
  fi

  mkdir -p "$target_dir"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --include='*/' --include='*.json' --exclude='*' "$source_dir/" "$target_dir/"
    return
  fi

  while IFS= read -r -d '' source_file; do
    local relative_path="${source_file#"$source_dir"/}"
    local target_file="$target_dir/$relative_path"
    mkdir -p "$(dirname "$target_file")"
    cp "$source_file" "$target_file"
  done < <(find "$source_dir" -type f -name '*.json' -print0)
}

has_files() {
  [ -d "$1" ] && [ -n "$(find "$1" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]
}

seed_worktree_jagentdesk_home() {
  local source_home="${JAGENTDESK_DEV_SEED_HOME:-$HOME/.jagentdesk}"
  if [ ! -d "$source_home" ] && [ -d "$HOME/.jagentdesk" ]; then
    # COMPAT(predecessorHome): allow a one-way dev seed from an older install.
    source_home="$HOME/.jagentdesk"
  fi
  local target_home="$1"

  if [ ! -d "$source_home" ]; then
    echo "  Seed:    skipped (${source_home} missing)"
    return
  fi

  if [ "$source_home" = "$target_home" ]; then
    echo "  Seed:    skipped (source is target)"
    return
  fi

  if [ "${JAGENTDESK_DEV_RESET_HOME:-0}" = "1" ]; then
    rm -rf "$target_home"
  elif has_files "$target_home"; then
    echo "  Seed:    skipped (${target_home} already has data)"
    return
  fi

  mkdir -p "$target_home"
  echo "  Seed:    copying metadata from ${source_home}"
  copy_json_tree "$source_home/agents" "$target_home/agents"
  copy_json_tree "$source_home/projects" "$target_home/projects"
  if [ -f "$source_home/config.json" ]; then
    cp "$source_home/config.json" "$target_home/config.json"
  fi

  echo "  Seed:    copied metadata from ${source_home}"
}

configure_dev_daemon_config() {
  if [ -z "${JAGENTDESK_LISTEN:-}" ]; then
    return
  fi

  mkdir -p "$JAGENTDESK_HOME"
  node -e '
const fs = require("fs");
const [path, listen] = [process.argv[1], process.argv[2]];
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path, "utf8")); } catch {}
cfg.version = cfg.version || 1;
cfg.daemon = cfg.daemon || {};
cfg.daemon.listen = listen;
cfg.daemon.cors = cfg.daemon.cors || {};
cfg.daemon.cors.allowedOrigins = ["*"];
fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
' "$JAGENTDESK_HOME/config.json" "$JAGENTDESK_LISTEN"
}

resolve_dev_daemon_endpoint() {
  if [ -n "${JAGENTDESK_DEV_DAEMON_ENDPOINT:-}" ]; then
    echo "$JAGENTDESK_DEV_DAEMON_ENDPOINT"
    return
  fi

  case "${JAGENTDESK_LISTEN:-127.0.0.1:6768}" in
    0.0.0.0:*) echo "localhost:${JAGENTDESK_LISTEN#0.0.0.0:}" ;;
    127.0.0.1:*) echo "localhost:${JAGENTDESK_LISTEN#127.0.0.1:}" ;;
    *) echo "$JAGENTDESK_LISTEN" ;;
  esac
}

configure_dev_jagentdesk_home() {
  if [ -n "${JAGENTDESK_HOME:-}" ]; then
    export JAGENTDESK_HOME
    if [ -n "${JAGENTDESK_DEV_SEED_HOME:-}" ]; then
      seed_worktree_jagentdesk_home "$JAGENTDESK_HOME"
    fi
    mkdir -p "$JAGENTDESK_HOME"
    if [ "${JAGENTDESK_DEV_MANAGED_HOME:-0}" = "1" ] || [ -n "${JAGENTDESK_DEV_SEED_HOME:-}" ]; then
      configure_dev_daemon_config
    fi
    return
  fi

  export JAGENTDESK_HOME
  local dev_root
  dev_root="${JAGENTDESK_DEV_ROOT:-$(default_dev_jagentdesk_root)}"
  JAGENTDESK_HOME="$dev_root/.dev/jagentdesk-home"
  export JAGENTDESK_DEV_MANAGED_HOME=1

  if [ -n "${JAGENTDESK_DEV_SEED_HOME:-}" ]; then
    seed_worktree_jagentdesk_home "$JAGENTDESK_HOME"
  fi

  mkdir -p "$JAGENTDESK_HOME"
  configure_dev_daemon_config
}

configure_dev_command_env() {
  if [ -z "${JAGENTDESK_LISTEN:-}" ]; then
    if [ -n "${JAGENTDESK_SERVICE_DAEMON_PORT:-}" ]; then
      export JAGENTDESK_LISTEN="0.0.0.0:${JAGENTDESK_SERVICE_DAEMON_PORT}"
    else
      export JAGENTDESK_LISTEN="127.0.0.1:6768"
    fi
  fi

  configure_dev_jagentdesk_home
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  if [ "$#" -gt 0 ]; then
    configure_dev_command_env
    exec "$@"
  fi

  configure_dev_jagentdesk_home
fi
