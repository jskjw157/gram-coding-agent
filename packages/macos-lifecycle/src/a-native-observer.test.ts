import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// All filesystem, account and native-process boundaries are synthetic. Keep
// the real record parsers and telemetry freshness rules under this observer.
const fixture = vi.hoisted(() => ({
  releaseDigest: 'a'.repeat(64),
  configDigest: 'b'.repeat(64),
  executionReads: 0,
  registrationReads: 0,
  proofCalls: 0,
  observedAtMs: 40_000,
  completedAtMs: 60_002,
  changeLease: false,
  changeRegistration: false,
  loseProcess: false,
  inode: 1n,
  device: 1n,
  requireExactIdentity: false,
}));
vi.mock('node:fs/promises', () => ({
  lstat: async (_path: string, options?: { bigint?: boolean }) =>
    options?.bigint
      ? { isFile: () => true, uid: 0n, nlink: 1n, mode: 0o755n, dev: fixture.device, ino: fixture.inode }
      : { isFile: () => true, uid: 0, nlink: 1, mode: 0o755, dev: Number(fixture.device), ino: Number(fixture.inode) },
}));
vi.mock('./adapters/macos-inspection.js', () => ({
  inspectMacAccount: async () => ({ name: 'gram-agent', admin: false, uid: 550, gid: 550 }),
}));
vi.mock('./a-system-sources.js', () => ({
  createInstalledRuntimeReviewSource: () => ({
    read: async () => ({
      config: { tunnel: { enabled: false }, releaseId: 'release', releaseDigest: fixture.releaseDigest },
      configDigest: fixture.configDigest,
      peerOwnerDigest: 'hash',
      nodeDigest: 'hash',
    }),
  }),
}));
vi.mock('./adapters/runtime-directories.js', () => ({
  inspectRuntimeDirectories: async () => ({ verify: async () => undefined, runPolicy: {} }),
}));
vi.mock('./adapters/execution-files.js', async () => {
  const { encodeExecution } = await import('./execution-lease.js');
  return {
    createExecutionFilesAt: () => ({
      async read() {
        fixture.executionReads++;
        return [
          encodeExecution({
            schemaVersion: 1,
            role: 'core',
            state: 'HELD',
            revision: fixture.changeLease && fixture.executionReads > 1 ? 3 : 1,
            token: '12345678-1234-4234-8234-123456789abc',
            generation: 'gen1',
            releaseDigest: fixture.releaseDigest,
            configDigest: fixture.configDigest,
          }),
        ];
      },
      async compareAndSwap() {
        throw new Error('UNEXPECTED_WRITE');
      },
    }),
  };
});
vi.mock('./adapters/core-process-files.js', async () => {
  const { encodeCoreRegistration } = await import('./core-registration.js');
  return {
    createCoreProcessFilesAt: () => ({
      async read() {
        fixture.registrationReads++;
        if (fixture.registrationReads > 1) vi.setSystemTime(fixture.completedAtMs);
        return [
          encodeCoreRegistration({
            schemaVersion: 1,
            role: 'core',
            configDigest: fixture.configDigest,
            executionRevision: 1,
            executionToken: '12345678-1234-4234-8234-123456789abc',
            child: {
              role: 'core',
              pid: 42,
              startIdentity: '1.1',
              generation: fixture.changeRegistration && fixture.registrationReads > 1 ? 'other' : 'gen1',
              releaseDigest: fixture.releaseDigest,
              uid: 550,
            },
          }),
        ];
      },
      async compareAndSwap() {
        throw new Error('UNEXPECTED_WRITE');
      },
    }),
  };
});
vi.mock('./adapters/trusted-files.js', () => ({
  createTrustedFiles: () => ({ hash: async () => 'hash' }),
}));
vi.mock('./adapters/owned-process.js', () => ({
  createNativePeerProof: () => ({
    async current(identity: { executable: { dev: bigint; ino: bigint } }) {
      fixture.proofCalls++;
      if (
        fixture.requireExactIdentity &&
        (identity.executable.dev !== fixture.device || identity.executable.ino !== fixture.inode)
      )
        return 'FOREIGN';
      return fixture.loseProcess && fixture.proofCalls > 1 ? 'UNKNOWN' : 'OWNED';
    },
  }),
}));
vi.mock('./adapters/runtime-stores.js', async () => {
  const { TelemetryStore } = await import('./telemetry-store.js');
  const { encodeStatus } = await import('./telemetry.js');
  return {
    createRuntimeStores: () => ({
      telemetry: new TelemetryStore(
        {
          async read() {
            return [
              encodeStatus({
                schemaVersion: 1,
                role: 'core',
                generation: 'gen1',
                releaseDigest: fixture.releaseDigest,
                code: 'OK',
                state: 'LOCAL_CORE_HEALTHY',
                observedAtMs: fixture.observedAtMs,
                attemptCount: 0,
              }),
            ];
          },
          async compareAndSwap() {
            throw new Error('UNEXPECTED_WRITE');
          },
        },
        {
          async read() {
            throw new Error('UNEXPECTED_EVENT_READ');
          },
          async compareAndSwap() {
            throw new Error('UNEXPECTED_WRITE');
          },
        },
      ),
    }),
  };
});

import { createInstalledHealthObserver } from './a-native-observer.js';

const platform = Object.getOwnPropertyDescriptor(process, 'platform');
const arch = Object.getOwnPropertyDescriptor(process, 'arch');
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
  vi.useFakeTimers();
  vi.setSystemTime(60_000);
  Object.assign(fixture, {
    executionReads: 0,
    registrationReads: 0,
    proofCalls: 0,
    observedAtMs: 40_000,
    completedAtMs: 60_002,
    changeLease: false,
    changeRegistration: false,
    loseProcess: false,
    inode: 1n,
    device: 1n,
    requireExactIdentity: false,
  });
});
afterEach(() => {
  if (platform) Object.defineProperty(process, 'platform', platform);
  if (arch) Object.defineProperty(process, 'arch', arch);
  vi.useRealTimers();
});

const observer = () => createInstalledHealthObserver(async () => false);
const signal = () => new AbortController().signal;

describe('native installed health at completion of all asynchronous guards', () => {
  it('accepts status still fresh after the final registration read', async () => {
    expect(await observer().healthy('core', signal())).toBe(true);
    expect(fixture.proofCalls).toBe(2);
    expect(fixture.executionReads).toBe(2);
    expect(fixture.registrationReads).toBe(2);
    expect(Date.now()).toBe(60_002);
  });

  it('preserves native device/inode identity above the Number precision limit', async () => {
    fixture.device = 9007199254740995n;
    fixture.inode = 9007199254740993n;
    fixture.requireExactIdentity = true;
    expect(await observer().healthy('core', signal())).toBe(true);
    expect(fixture.proofCalls).toBe(2);
  });

  it('refuses status that expires during the final guard, despite unchanged live ownership', async () => {
    fixture.observedAtMs = 30_001; // 29,999 ms old at the telemetry read.
    expect(await observer().healthy('core', signal())).toBe(false);
    expect(fixture.registrationReads).toBe(2);
    expect(Date.now() - fixture.observedAtMs).toBe(30_001);
  });

  it('refuses status that becomes future-dated when the clock rolls back during final guards', async () => {
    fixture.observedAtMs = 59_999;
    fixture.completedAtMs = 59_998;
    expect(await observer().healthy('core', signal())).toBe(false);
    expect(fixture.registrationReads).toBe(2);
  });

  it('refuses the exact 30-second expiry boundary at completion', async () => {
    fixture.observedAtMs = 30_002;
    expect(await observer().healthy('core', signal())).toBe(false);
    expect(Date.now() - fixture.observedAtMs).toBe(30_000);
  });

  it('accepts the last millisecond before expiry at completion', async () => {
    fixture.observedAtMs = 30_003;
    expect(await observer().healthy('core', signal())).toBe(true);
    expect(Date.now() - fixture.observedAtMs).toBe(29_999);
  });

  it.each(['changeLease', 'changeRegistration', 'loseProcess'] as const)(
    'continues refusing changed ownership evidence: %s',
    async (change) => {
      fixture[change] = true;
      expect(await observer().healthy('core', signal())).toBe(false);
    },
  );
});
