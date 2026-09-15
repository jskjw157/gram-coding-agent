#!/usr/bin/env bash
set -euo pipefail

log() { printf '[bootstrap-wsl] %s\n' "$*" >&2; }
die() { printf '[bootstrap-wsl] ERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GRAM_AGENT_USER="${GRAM_AGENT_USER:-$(id -un)}"
CURRENT_USER="$(id -un)"

[[ "$CURRENT_USER" != root ]] || die 'run this bootstrap as the dedicated non-root Gram runtime user with sudo access'
[[ "$GRAM_AGENT_USER" == "$CURRENT_USER" ]] || die 'GRAM_AGENT_USER must match the user running this bootstrap'

grep -qiE '(microsoft|wsl)' /proc/sys/kernel/osrelease || die 'this bootstrap must run inside WSL2'
[[ "$(ps -p 1 -o comm= | tr -d '[:space:]')" == systemd ]] || die 'WSL systemd is not enabled (PID 1 is not systemd)'

need sudo
need node
need pnpm
need openssl
need tunnel-client
need systemctl
need sed
need install

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" == 24 ]] || die "Node 24 is required; found $(node --version)"
pnpm --version >/dev/null

tunnel-client --version >/dev/null
[[ -f "$REPO_ROOT/apps/agent/dist/main.js" ]] || die 'built agent not found; run pnpm install --frozen-lockfile && pnpm build first'

GRAM_AGENT_HOME="$(getent passwd "$GRAM_AGENT_USER" | cut -d: -f6)"
[[ -n "$GRAM_AGENT_HOME" ]] || die "could not resolve home directory for $GRAM_AGENT_USER"

GRAM_AGENT_STATE_DIR="$GRAM_AGENT_HOME/.gram-agent"
GRAM_AGENT_SECRET_DIR="$GRAM_AGENT_HOME/.config/gram-coding-agent/secrets"
GRAM_MCP_INTERNAL_SECRET_FILE="$GRAM_AGENT_SECRET_DIR/mcp-internal-secret"
ETC_DIR='/etc/gram-coding-agent'
RUNTIME_ENV="$ETC_DIR/tunnel-runtime.env"
TUNNEL_CONFIG="$ETC_DIR/tunnel-client.yaml"

mkdir -p "$GRAM_AGENT_STATE_DIR" "$GRAM_AGENT_SECRET_DIR"
chmod 700 "$GRAM_AGENT_STATE_DIR" "$GRAM_AGENT_SECRET_DIR"

if [[ ! -f "$GRAM_MCP_INTERNAL_SECRET_FILE" ]]; then
  umask 077
  openssl rand -hex 32 >"$GRAM_MCP_INTERNAL_SECRET_FILE"
  chmod 600 "$GRAM_MCP_INTERNAL_SECRET_FILE"
  log "generated internal MCP secret at $GRAM_MCP_INTERNAL_SECRET_FILE"
else
  chmod 600 "$GRAM_MCP_INTERNAL_SECRET_FILE"
  log 'preserved existing internal MCP secret'
fi

sudo install -d -m 0755 "$ETC_DIR"

escape_sed_replacement() {
  printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
}

render_template() {
  local source="$1" destination="$2"
  local repo user state secrets internal_secret
  repo="$(escape_sed_replacement "$REPO_ROOT")"
  user="$(escape_sed_replacement "$GRAM_AGENT_USER")"
  state="$(escape_sed_replacement "$GRAM_AGENT_STATE_DIR")"
  secrets="$(escape_sed_replacement "$GRAM_AGENT_SECRET_DIR")"
  internal_secret="$(escape_sed_replacement "$GRAM_MCP_INTERNAL_SECRET_FILE")"

  sed \
    -e "s|__GRAM_AGENT_REPO_ROOT__|$repo|g" \
    -e "s|__GRAM_AGENT_USER__|$user|g" \
    -e "s|__GRAM_AGENT_STATE_DIR__|$state|g" \
    -e "s|__GRAM_AGENT_SECRET_DIR__|$secrets|g" \
    -e "s|__GRAM_MCP_INTERNAL_SECRET_FILE__|$internal_secret|g" \
    "$source" | sudo tee "$destination" >/dev/null
}

render_template "$REPO_ROOT/config/tunnel-client.example.yaml" "$TUNNEL_CONFIG"
sudo chmod 640 "$TUNNEL_CONFIG"
sudo chown root:"$GRAM_AGENT_USER" "$TUNNEL_CONFIG"

if [[ ! -e "$RUNTIME_ENV" ]]; then
  sudo tee "$RUNTIME_ENV" >/dev/null <<EOF
# Fill the two empty runtime values before running tunnel-client doctor.
CONTROL_PLANE_TUNNEL_ID=
CONTROL_PLANE_API_KEY=
GRAM_MCP_INTERNAL_SECRET_FILE=$GRAM_MCP_INTERNAL_SECRET_FILE
EOF
  sudo chmod 600 "$RUNTIME_ENV"
  sudo chown root:root "$RUNTIME_ENV"
  log "created $RUNTIME_ENV without provisioning control-plane credentials"
else
  log "preserved existing $RUNTIME_ENV"
fi

render_template "$REPO_ROOT/systemd/gram-coding-agent.service" '/etc/systemd/system/gram-coding-agent.service'
render_template "$REPO_ROOT/systemd/openai-mcp-tunnel.service" '/etc/systemd/system/openai-mcp-tunnel.service'
sudo chmod 644 /etc/systemd/system/gram-coding-agent.service /etc/systemd/system/openai-mcp-tunnel.service

sudo systemctl daemon-reload

log 'systemd units installed and daemon reloaded'
log "next: populate CONTROL_PLANE_TUNNEL_ID and CONTROL_PLANE_API_KEY in $RUNTIME_ENV"
log 'then run tunnel-client doctor --config /etc/gram-coding-agent/tunnel-client.yaml --explain before enabling services'
