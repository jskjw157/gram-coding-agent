import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('M1 systemd and tunnel-client contract', () => {
  it('keeps both services restartable and orders the tunnel after the agent', () => {
    const agentUnit = read('systemd/gram-coding-agent.service');
    const tunnelUnit = read('systemd/openai-mcp-tunnel.service');

    expect(agentUnit).toContain('Restart=on-failure');
    expect(tunnelUnit).toContain('Restart=on-failure');
    expect(tunnelUnit).toContain('After=gram-coding-agent.service');
    expect(tunnelUnit).not.toContain('OPENAI_ADMIN_KEY');
    expect(tunnelUnit).toContain('tunnel-client run --config /etc/gram-coding-agent/tunnel-client.yaml');
  });

  it('targets the loopback MCP server and uses a file-backed internal auth header', () => {
    const config = read('config/tunnel-client.example.yaml');
    expect(config).toContain('http://127.0.0.1:3847/mcp');
    expect(config).toContain('X-Gram-Agent-Auth');
    expect(config).toMatch(/X-Gram-Agent-Auth:\s*file:/);
    expect(config).toContain('CONTROL_PLANE_TUNNEL_ID');
    expect(config).toContain('CONTROL_PLANE_API_KEY');
    expect(config).toContain('GRAM_MCP_INTERNAL_SECRET_FILE');
  });

  it('bootstrap is strict, creates protected secret storage, and never provisions an admin key', () => {
    const bootstrap = read('scripts/bootstrap-wsl.sh');
    expect(bootstrap).toContain('set -euo pipefail');
    expect(bootstrap).toContain('systemctl');
    expect(bootstrap).toContain('chmod 700');
    expect(bootstrap).toContain('chmod 600');
    expect(bootstrap).toContain('GRAM_MCP_INTERNAL_SECRET_FILE');
    expect(bootstrap).not.toContain('OPENAI_ADMIN_KEY');
  });
});
