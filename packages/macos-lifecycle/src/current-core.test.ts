import { afterEach, describe, expect, it, vi } from 'vitest';
import { configDigest } from './config.js';
import { createCurrentCoreReader } from './current-core.js';
import { encodeCoreRegistration } from './core-registration.js';
import { config, digest, discoveryFixture, signal } from './test-support/runtime/discovery.js';

afterEach(() => vi.useRealTimers());
describe('independent Core observer (synthetic native proof and wire, not installed acceptance)', () => {
  it('combines lease, current status, exact peer proof and the existing five-step health protocol', async () => {
    const f = await discoveryFixture(); const before = f.recordBytes.writes();
    expect(await createCurrentCoreReader(config(), f.deps)(signal())).toEqual({ state: 'LOCAL_CORE_HEALTHY', code: 'OK',
      generation: 'g1', releaseDigest: digest, observedAtMs: 1000 });
    expect(f.sent).toEqual(['health', 'initialize', 'initialized', 'tools', 'call']);
    expect(f.secretUses()).toBe(4); expect(f.recordBytes.writes()).toBe(before);
    expect(f.trace).toContain('peer:3847:51000'); expect(f.trace).toContain('current:4242:1700000000.123456');
  });
  it.each(['absent', 'free', 'stale', 'future', 'stopping', 'wrong-generation', 'wrong-release'])('sends no bytes or credential access for %s evidence', async kind => {
    const f = await discoveryFixture();
    if (kind === 'absent') f.recordBytes.values.clear();
    if (kind === 'free') await f.execution.release(f.lease);
    if (kind === 'stale') f.setClock(31000);
    if (kind === 'future') f.setClock(999);
    if (kind === 'stopping') f.setStatus({ ...f.status(), state: 'STOPPING' });
    if (kind === 'wrong-generation') f.setStatus({ ...f.status(), generation: 'g2' });
    if (kind === 'wrong-release') f.setStatus({ ...f.status(), releaseDigest: 'b'.repeat(64) });
    expect(await createCurrentCoreReader(config(), f.deps)(signal())).toBeNull();
    expect(f.sent).toEqual([]); expect(f.secretUses()).toBe(0);
  });
  it.each(['FOREIGN', 'UNKNOWN'] as const)('does not authenticate a peer classified %s', async verdict => {
    const f = await discoveryFixture(); f.proof.peer = async () => verdict;
    expect(await createCurrentCoreReader(config(), f.deps)(signal())).toBeNull();
    expect(f.secretUses()).toBe(0); expect(f.sent).toEqual([]);
  });
  it('rejects a matching record with no independently trusted authority', async () => {
    const f = await discoveryFixture(); f.deps.authority.acquire = async () => null;
    expect(await createCurrentCoreReader(config(), f.deps)(signal())).toBeNull(); expect(f.secretUses()).toBe(0);
  });
  it('checks the grant account against the recorded UID', async () => {
    const f = await discoveryFixture(); const original = f.deps.authority.acquire;
    f.deps.authority.acquire = async (...args) => { const grant = await original(...args); if (!grant) return null;
      return { ...grant, account: { ...grant.account, uid: 502 } }; };
    expect(await createCurrentCoreReader(config(), f.deps)(signal())).toBeNull(); expect(f.secretUses()).toBe(0);
  });
  it('rejects a reused PID/start mismatch even when the record and status are fresh', async () => {
    const f = await discoveryFixture(); f.proof.current = async () => 'FOREIGN';
    expect(await createCurrentCoreReader(config(), f.deps)(signal())).toBeNull(); expect(f.secretUses()).toBe(0);
  });
  it('rechecks reservation immediately after peer verification', async () => {
    const f = await discoveryFixture(); f.proof.peer = async () => { await f.execution.release(f.lease); return 'OWNED'; };
    expect(await createCurrentCoreReader(config(), f.deps)(signal())).toBeNull(); expect(f.secretUses()).toBe(0);
  });
  it('does not send credentials if the Core changes while the credential provider is resolving', async () => {
    const f = await discoveryFixture(); f.deps.credentials = { async withValue(use) {
      await f.execution.release(f.lease); return use('SYNTHETIC_AFTER_EXIT');
    } };
    expect(await createCurrentCoreReader(config(), f.deps)(signal())).toBeNull(); expect(f.sent).toEqual(['health']);
  });
  it('rechecks process registration before accepting the final health result', async () => {
    const f = await discoveryFixture(); const original = f.deps.connections; if (!original) throw new Error('connections');
    f.deps.connections = verifier => { const inner = original(verifier); return {
      async openOwnedConnection(...args) { const c = await inner.openOwnedConnection(...args); if (!c) return null;
        const request = c.request.bind(c); c.request = async (...params) => {
          const r = await request(...params);
          if (params[0] === 'call') { const record = await f.registration.read(); if (!record) throw new Error('record');
            f.recordBytes.values.set('core', encodeCoreRegistration({ ...record, child: { ...record.child, pid: 5000 } })); }
          return r;
        }; return c;
      },
    }; };
    expect(await createCurrentCoreReader(config(), f.deps)(signal())).toBeNull();
  });
  it('accepts a refreshed heartbeat without confusing it with a new process generation', async () => {
    const f = await discoveryFixture(); const original = f.proof.current;
    f.proof.current = async (...args) => { f.setStatus({ ...f.status(), observedAtMs: 1001 }); f.setClock(1001); return original(...args); };
    expect(await createCurrentCoreReader(config(), f.deps)(signal())).toMatchObject({ state: 'LOCAL_CORE_HEALTHY', generation: 'g1' });
  });
  it('rejects a new HELD acquisition even if it has the same configuration', async () => {
    const f = await discoveryFixture(); await f.execution.release(f.lease);
    await f.execution.acquire('core', 'g2', configDigest(config()), digest);
    expect(await createCurrentCoreReader(config(), f.deps)(signal())).toBeNull(); expect(f.secretUses()).toBe(0);
  });
  it('cancels before any read and bounds a hanging discovery source', async () => {
    const f = await discoveryFixture(); const controller = new AbortController(); controller.abort('SYNTHETIC_PRIVATE');
    expect(await createCurrentCoreReader(config(), f.deps)(controller.signal)).toBeNull(); expect(f.statusReads()).toBe(0);
    vi.useFakeTimers(); f.deps.registration = { read: async () => new Promise(() => {}) };
    const pending = createCurrentCoreReader(config(), f.deps)(signal()); await vi.advanceTimersByTimeAsync(10001);
    expect(await pending).toBeNull(); expect(f.secretUses()).toBe(0);
  });
  it('does not leak arbitrary provider errors', async () => {
    const f = await discoveryFixture(); f.deps.status = async () => { throw new Error('/Users/private/SYNTHETIC_TOKEN'); };
    expect(await createCurrentCoreReader(config(), f.deps)(signal())).toBeNull(); expect(f.secretUses()).toBe(0);
  });
});
