#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$SCRIPT_DIR/../node_modules/.bin:$PATH"

source "$SCRIPT_DIR/dev-home.sh"

export JAGENTDESK_LISTEN="${JAGENTDESK_LISTEN:-127.0.0.1:6768}"
configure_dev_jagentdesk_home

if [ -z "${JAGENTDESK_LOCAL_MODELS_DIR}" ]; then
  export JAGENTDESK_LOCAL_MODELS_DIR="$HOME/.jagentdesk/models/local-speech"
  mkdir -p "$JAGENTDESK_LOCAL_MODELS_DIR"
fi

echo "══════════════════════════════════════════════════════"
echo "  JAgentDesk Dev Daemon"
echo "══════════════════════════════════════════════════════"
echo "  Home:    ${JAGENTDESK_HOME}"
echo "  Models:  ${JAGENTDESK_LOCAL_MODELS_DIR}"
echo "  Listen:  ${JAGENTDESK_LISTEN}"
echo "══════════════════════════════════════════════════════"

export JAGENTDESK_CORS_ORIGINS="${JAGENTDESK_CORS_ORIGINS:-*}"
export JAGENTDESK_NODE_INSPECT="${JAGENTDESK_NODE_INSPECT:---inspect=0}"

if [ "${JAGENTDESK_SKIP_DEV_SERVER_BUILD:-0}" = "1" ]; then
  exec npm run dev:server:watch
fi

exec sh -c 'npm run build:server-deps && npm run dev:server:watch'
