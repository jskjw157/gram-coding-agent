import { spawn, type ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { configDigest } from './config.js';
import type { AccountIdentity } from './contracts.js';
import type { CoreEvidence } from './health-probe.js';
import type { TunnelCompatibility } from './supervisor.js';
import { createNativeTunnelCustody } from './adapters/native-tunnel.js';
import type { ExecutableIdentity, NativePeerProofPort } from './adapters/owned-process.js';

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

describe('native tunnel ambiguous cleanup', () => {
  it('does not reject a failed start while a sealed tunnel child is still alive', async () => {
    let child: ChildProcess | null = null;
    let syntheticAbort = false;
    const controller = new AbortController();
    Object.defineProperty(controller.signal, 'aborted', {
      configurable: true,
      get() { return syntheticAbort; },
    });

    const unstableProof: NativePeerProofPort = Object.freeze({
      async capture() { syntheticAbort = true; return { sec: '1700000000', usec: '11' }; },
      async current() { return 'FOREIGN'; },
      async peer() { return 'UNKNOWN'; },
    });

    const port = createNativeTunnelCustody({
      authority: {
        async acquire() {
          return { configDigest: configDigest(config), compatibilityDigest,
            account, executable, proof: unstableProof };
        },
      },
      launch() {
        child = spawn(process.execPath, ['-e',
          "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);"
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        return child;
      },
    });

    const starting = port.spawn(config, compatibility, core, 'g-ambiguous', controller.signal);
    while (child === null || child.pid === undefined) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }

    const early = await Promise.race([
      starting.then(() => 'fulfilled', () => 'rejected'),
      new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), 50)),
    ]);

    const running = child;
    if (running.exitCode === null && running.signalCode === null) running.kill('SIGKILL');
    await new Promise<void>(resolve => {
      if (running.exitCode !== null || running.signalCode !== null) resolve();
      else running.once('exit', () => resolve());
    });
    await starting.catch(() => undefined);

    expect(early).toBe('pending');
  }, 5000);
});
