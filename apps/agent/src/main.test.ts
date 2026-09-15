import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startAgent, type RunningAgent } from './main.js';

const tempDirs: string[] = [];
const running: RunningAgent[] = [];

afterEach(async () => {
  let app: RunningAgent | undefined;
  while ((app = running.pop()) !== undefined) await app.close();
  let dir: string | undefined;
  while ((dir = tempDirs.pop()) !== undefined) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gram-agent-'));
  tempDirs.push(root);
  const stateDirectory = join(root, 'state');
  const secretDirectory = join(root, 'secrets');
  mkdirSync(stateDirectory, { recursive: true });
  mkdirSync(secretDirectory, { recursive: true, mode: 0o700 });
  const secretPath = join(secretDirectory, 'mcp-internal-secret');
  writeFileSync(secretPath, 'integration-secret\n', { mode: 0o600 });
  chmodSync(secretPath, 0o600);
  return { stateDirectory, secretDirectory };
}

describe('agent composition root', () => {
  it('starts loopback MCP and reports healthy database/MCP state', async () => {
    const paths = fixture();
    const app = await startAgent({
      ...paths,
      host: '127.0.0.1',
      port: 0,
      installSignalHandlers: false,
    });
    running.push(app);

    expect(app.host).toBe('127.0.0.1');
    expect(app.port).toBeGreaterThan(0);

    const response = await fetch(`${app.url}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'healthy', database: 'ok', mcp: 'ready' });
    expect(app.health()).toEqual({ status: 'healthy', database: 'ok', mcp: 'ready' });
  });

  it('closes the listener and database cleanly', async () => {
    const app = await startAgent({ ...fixture(), port: 0, installSignalHandlers: false });
    const url = app.url;
    await app.close();
    await expect(fetch(`${url}/healthz`)).rejects.toThrow();
  });
});
