import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCoreResumeProof } from './core-resume-proof.js';
import { encodeExecution } from './execution-lease.js';
import { coreStartIdentity, encodeCoreRegistration } from './core-registration.js';
import { discoveryFixture, digest } from './test-support/runtime/discovery.js';
import { freshHistory } from './circuit.js';
import type { PeerVerdict } from './adapters/owned-process.js';
async function fixture(hang?: 'load' | 'hash' | 'verify', requireSignal = false) {
  const f = await discoveryFixture();
  const held = await f.execution.read('core');
  const registration = await f.registration.read();
  if (!registration) throw new Error('FIXTURE');
  const start = coreStartIdentity(registration.child.startIdentity);
  let generation = registration.child.generation;
  let gate: Promise<void> | undefined;
  let verdict: PeerVerdict = 'OWNED';
  let drift = false;
  let blocked = false;
  const calls: unknown[] = [];
  const never = () => new Promise<never>(() => {});
  const proof = createCoreResumeProof(async () =>
    hang === 'load'
      ? never()
      : {
          held: encodeExecution(held),
          registration: encodeCoreRegistration(registration),
          revision: held.revision,
          generation: registration.child.generation,
          identity: {
            pid: registration.child.pid,
            uid: registration.child.uid,
            startSec: start.sec,
            startUsec: start.usec,
            executable: { dev: 7n, ino: 8n },
          },
          peer: {
            async current(identity) {
              calls.push(identity);
              if (gate) await gate;
              return verdict;
            },
          },
          files: {
            async hash() {
              if (hang === 'hash') return never();
              return drift ? '0'.repeat(64) : digest;
            },
          },
          helperDigest: digest,
          nodeDigest: digest,
          execution: {
            async read(role, signal: AbortSignal) {
              if (requireSignal && (!signal || signal.aborted)) throw new Error('STALE_SIGNAL');
              return f.execution.read(role);
            },
          },
          registrationStore: f.registration,
          lifecycle: {
            async read() {
              return { role: 'core', digest, history: { ...freshHistory(100), blocked, lastGeneration: generation } };
            },
          },
          verify: async () => {
            if (hang === 'verify') await never();
          },
        },
  );
  return {
    f,
    proof,
    calls,
    setVerdict: (value: PeerVerdict) => {
      verdict = value;
    },
    tamper: () => {
      drift = true;
    },
    block: () => {
      blocked = true;
    },
    setGeneration: (value: string) => {
      generation = value;
    },
    setGate: (value: Promise<void>) => {
      gate = value;
    },
  };
}
afterEach(() => vi.useRealTimers());
describe('same captured Core process stop proof', () => {
  it('requires the released matching lease plus two exact native FOREIGN observations', async () => {
    const s = await fixture();
    const pin = await s.proof.capture();
    expect(pin).toMatch(/^[a-f0-9]{64}$/);
    await s.f.execution.release(s.f.lease);
    s.setVerdict('FOREIGN');
    expect(await s.proof.current(pin ?? '', 'FOREIGN')).toBe(true);
    expect(s.calls).toHaveLength(4);
    expect(s.calls[0]).toEqual(s.calls[3]);
  });
  it.each(['OWNED', 'UNKNOWN'] as const)('does not treat %s as stopped after a lease release', async (verdict) => {
    const s = await fixture();
    const pin = await s.proof.capture();
    await s.f.execution.release(s.f.lease);
    s.setVerdict(verdict);
    expect(await s.proof.current(pin ?? '', 'FOREIGN')).toBe(false);
  });
  it('does not let a native FOREIGN verdict override a still HELD lease', async () => {
    const s = await fixture();
    const pin = await s.proof.capture();
    s.setVerdict('FOREIGN');
    expect(await s.proof.current(pin ?? '', 'FOREIGN')).toBe(false);
  });
  it('refuses changed helpers or blocked history without resetting any record', async () => {
    const s = await fixture();
    const pin = await s.proof.capture();
    await s.f.execution.release(s.f.lease);
    s.setVerdict('FOREIGN');
    s.block();
    expect(await s.proof.current(pin ?? '', 'FOREIGN')).toBe(false);
    s.tamper();
    expect(await s.proof.current(pin ?? '', 'FOREIGN')).toBe(false);
    expect((await s.f.execution.read('core')).revision).toBe(2);
  });
  it('requires the exact opaque pin and refuses an unknown capture', async () => {
    const s = await fixture();
    s.setVerdict('UNKNOWN');
    expect(await s.proof.capture()).toBeNull();
    expect(await s.proof.current('0'.repeat(64), 'FOREIGN')).toBe(false);
  });
  it('refuses history belonging to a different generation after stop', async () => {
    const s = await fixture();
    const pin = await s.proof.capture();
    await s.f.execution.release(s.f.lease);
    s.setVerdict('FOREIGN');
    s.setGeneration('different-generation');
    expect(await s.proof.current(pin ?? '', 'FOREIGN')).toBe(false);
  });
  it.each(['deadline', 'parent'] as const)('rejects a late native verdict after %s cancellation', async (kind) => {
    const s = await fixture();
    const pin = await s.proof.capture();
    vi.useFakeTimers();
    let release!: () => void;
    s.setGate(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const parent = new AbortController();
    const result = s.proof.current(pin ?? '', 'OWNED', parent.signal);
    if (kind === 'deadline') await vi.advanceTimersByTimeAsync(60001);
    else parent.abort();
    release();
    expect(await result).toBe(false);
  });
});

it.each(['load', 'hash', 'verify'] as const)('returns before a never-settling %s read completes', async (hang) => {
  const s = await fixture(hang);
  vi.useFakeTimers();
  let settled = false;
  const result = s.proof.capture().then((value) => {
    settled = true;
    return value;
  });
  await vi.advanceTimersByTimeAsync(60001);
  expect(settled).toBe(true);
  expect(await result).toBeNull();
  expect(await s.proof.current('a'.repeat(64), 'OWNED')).toBe(false);
});

it('supplies fresh observation signals to reusable records after capture has closed', async () => {
  const s = await fixture(undefined, true);
  const pin = await s.proof.capture();
  expect(pin).toMatch(/^[a-f0-9]{64}$/);
  expect(await s.proof.current(pin ?? '', 'OWNED')).toBe(true);
  await s.f.execution.release(s.f.lease);
  s.setVerdict('FOREIGN');
  expect(await s.proof.current(pin ?? '', 'FOREIGN')).toBe(true);
});
