import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { inspectMacPorts, inspectMacRegistry, validateMacPlists } from './adapters/macos-service-probes.js';
import { renderPlist } from './launchd-plist.js';
import { labConfig } from './test-support/fixtures.js';

describe.skipIf(process.platform !== 'darwin')('actual macOS read-only service probes', () => {
  it('queries the system registry without installing or starting a job', async () => {
    const state = await inspectMacRegistry();
    expect(state).not.toBeNull();
    expect(state?.jobs).toEqual({ core: 'absent', tunnel: 'absent' });
    expect(state?.overrides).toEqual({ core: null, tunnel: null });
  });
  it('observes a real fixed-port fixture without connecting to it', async context => {
    const initial = await inspectMacPorts();
    expect(initial.core).not.toBe('unknown');
    if (initial.core !== 'free') { context.skip(); return; }
    let connections = 0;
    const server = createServer(socket => { connections++; socket.destroy(); });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject); server.listen(3847, '127.0.0.1', resolve);
      });
      expect((await inspectMacPorts()).core).toBe('occupied');
      expect(connections).toBe(0);
    } finally {
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    expect((await inspectMacPorts()).core).toBe('free');
  });
  it('validates generated XML through plutil stdin without creating a file', async () => {
    expect(await validateMacPlists([renderPlist(labConfig(), 'core')])).toBe(true);
    expect(await validateMacPlists(['<not-a-plist>'])).toBe(false);
    expect(await validateMacPlists([])).toBe(false);
    expect(await validateMacPlists(['x'.repeat(262145)])).toBe(false);
  });
});
