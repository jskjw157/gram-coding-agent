import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { configDigest } from '../config.js';
import type { AccountIdentity, OwnedChild } from '../contracts.js';
import type { CoreEvidence } from '../health-probe.js';
import type { TunnelCompatibility } from '../supervisor.js';
import { createNativeTunnelCustody, type TunnelCustodyPort } from './native-tunnel.js';
import type { ExecutableIdentity, NativePeerProofPort, PeerVerdict } from './owned-process.js';

const releaseDigest = 'a'.repeat(64);
const compatibilityDigest = 'b'.repeat(64);
const config = {
  schemaVersion: 1 as const, mode: 'LAB_ONLY' as const, runtimeUser: 'gram-agent' as const,
  releaseId: 'lab-tunnel', releaseDigest,
  tunnel: { enabled: true as const, compatibilityDigest, credentialRef: 'test-tunnel-key' as const },
};
const compatibility: TunnelCompatibility = Object.freeze({ digest: compatibilityDigest });
const core: CoreEvidence = Object.freeze({
  state: 'LOCAL_CORE_HEALTHY', code: 'OK', generation: 'core-g1', releaseDigest, observedAtMs: 10,
});
const account: AccountIdentity = Object.freeze({
  name: 'gram-agent', uid: process.getuid?.() ?? 501, gid: process.getgid?.() ?? 20, admin: false,
});
const executable: ExecutableIdentity = Object.freeze({ dev: 11n, ino: 22n });

describe('native tunnel current ownership proof', () => {
  it('revalidates the exact active tunnel child without signalling it', async () => {
    let verdict: PeerVerdict = 'OWNED';
    let currentCalls = 0;
    const proof: NativePeerProofPort = Object.freeze({
      async capture() { return { sec: '1700000000', usec: '13' }; },
      async current() { currentCalls++; return verdict; },
      async peer() { return 'UNKNOWN'; },
    });
    const port = createNativeTunnelCustody({
      authority: { async acquire() {
        return { configDigest: configDigest(config), compatibilityDigest, account, executable, proof };
      } },
      launch() {
        return spawn(process.execPath, ['-e',
          "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),5));setInterval(()=>{},1000);"
        ], { stdio: ['ignore','pipe','pipe'] });
      },
    }) as TunnelCustodyPort & {
      current?: (child: OwnedChild, signal: AbortSignal) => Promise<boolean>;
    };

    expect(port.current).toBeTypeOf('function');
    if (!port.current) return;
    const managed = await port.spawn(config, compatibility, core, 'tg1', new AbortController().signal);
    expect(await port.current(managed.child, new AbortController().signal)).toBe(true);

    const wrong = { ...managed.child, generation: 'foreign' };
    const beforeWrong = currentCalls;
    expect(await port.current(wrong, new AbortController().signal)).toBe(false);
    expect(currentCalls).toBe(beforeWrong);

    verdict = 'FOREIGN';
    expect(await port.current(managed.child, new AbortController().signal)).toBe(false);

    verdict = 'OWNED';
    await port.stop(managed, 20000, new AbortController().signal);
    await managed.exited;
    const afterExit = currentCalls;
    expect(await port.current(managed.child, new AbortController().signal)).toBe(false);
    expect(currentCalls).toBe(afterExit);
  }, 5000);
});
