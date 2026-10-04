#!/bin/zsh
# Tunnel launcher for com.haar.gram-agent.tunnel (runs as mac_ops).
# Loads credentials ONLY from a 0600 owner-read env file. Never pass
# CONTROL_PLANE_API_KEY on the command line, and never log it.
set -u
ENV_FILE="${GRAM_TUNNEL_ENV_FILE:-/Users/mac_ops/.config/gram-coding-agent/tunnel-runtime.env}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "tunnel env file missing: $ENV_FILE" >&2
  exit 1
fi
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a
if [[ -z "${CONTROL_PLANE_TUNNEL_ID:-}" || -z "${CONTROL_PLANE_API_KEY:-}" ]]; then
  echo "tunnel env incomplete (need CONTROL_PLANE_TUNNEL_ID + CONTROL_PLANE_API_KEY)" >&2
  exit 1
fi
exec tunnel-client run --config "${GRAM_TUNNEL_CONFIG:-/Users/mac_ops/.config/gram-coding-agent/tunnel-client.yaml}"
