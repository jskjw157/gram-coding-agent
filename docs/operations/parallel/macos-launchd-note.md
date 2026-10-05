# macOS launchd composition (target-Mac bring-up, NOT yet loaded)

Status: files only. Daemons are NOT loaded anywhere. Loading requires
tunnel credentials (user-side) + one explicit go-ahead.

## Files

- `platform/macos/launchd/com.haar.gram-agent.core.plist` — agent MCP on
  127.0.0.1:3847 as `mac_ops`. `RunAtLoad=false`, `KeepAlive=true`.
- `platform/macos/launchd/com.haar.gram-agent.tunnel.plist` — tunnel daemon
  as `mac_ops` via `run-tunnel.sh`. `RunAtLoad=false`.
- `platform/macos/launchd/run-tunnel.sh` — sources the 0600 env file,
  refuses to start when ID/key are missing. No credentials in plist,
  repo, or logs.

## Placeholders (replaced at install, never committed with values)

- `__GRAM_AGENT_REPO_ROOT__` — repo checkout path on the target Mac.
- `/Users/mac_ops/.config/gram-coding-agent/tunnel-runtime.env` (0600,
  owner `mac_ops`) — `CONTROL_PLANE_TUNNEL_ID` + `CONTROL_PLANE_API_KEY`
  (Restricted, Tunnels Read + Use). Created by the user/admin, never by CI.
- `/Users/mac_ops/.config/gram-coding-agent/tunnel-client.yaml` —
  tunnel-client YAML v1 config targeting `http://127.0.0.1:3847/mcp`
  with `X-Gram-Agent-Auth` from a `file:` secret reference.

## Validation performed

- `plutil -lint` on both plists (syntax).
- `zsh -n` on `run-tunnel.sh` (syntax, no execution).
- Live MCP round-trip already proven separately on this Mac
  (`/healthz` + initialize + `tools/list` + `tools/call agent_health`,
  401 without secret).

## Still required (user-side)

1. Tunnel ID + Restricted API key (OpenAI dashboard).
2. Explicit go-ahead to copy plists to `/Library/LaunchDaemons`,
   create the 0600 env file, `bootstrap load`, and start core→tunnel.
3. ChatGPT connector enrollment while the daemon is healthy.
