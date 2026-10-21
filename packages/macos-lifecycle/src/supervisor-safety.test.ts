import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Role, ServiceConfig } from './contracts.js';
import type { SupervisorDeps } from './supervisor.js';
import { runSupervisor } from './supervisor.js';
import { digest, fixture, labConfig, managed } from './test-support/supervisor-fixture.js';
afterEach(() => vi.useRealTimers());
const run = (f: Awaited<ReturnType<typeof fixture>>, role: Role = 'core') =>
  runSupervisor(role, labConfig(role === 'tunnel'), f.deps, f.controller.signal);

describe('core lifecycle integration with real state stores', () => {
  it('publishes five-second healthy observations and excludes a confirmed intentional stop from crashes', async () => {
    const f = await fixture(); expect(await run(f)).toBe(0);
    expect(f.trace.filter(x => x === 'spawn:core')).toHaveLength(1);
    expect(f.statuses.filter(s => s.state === 'LOCAL_CORE_HEALTHY').map(s => s.observedAtMs)).toEqual([0, 5000]);
    expect(f.trace).toContain('stop:core:20000:false');
    const h = (await f.deps.lifecycle.read('core')).history;
    expect(h.activeAttempt).toBeNull(); expect(h.exitsMs).toEqual([]);
    expect(f.statuses.at(-1)?.state).toBe('STOPPED');
  });
  it('caps startup at sixty seconds instead of extending the deadline with backoff', async () => {
    const f = await fixture(100000); f.deps.core.probe = async c => ({ ...f.evidence(c.generation), state: 'UNKNOWN', code: 'HEALTH_UNKNOWN' });
    expect(await run(f)).toBe(1); expect(f.clock.time).toBe(60000);
    expect(f.clock.delays).toEqual([1000, 2000, 4000, 8000, 16000, 29000]);
    expect(f.statuses.some(s => s.state === 'LOCAL_CORE_HEALTHY')).toBe(false);
    expect((await f.deps.lifecycle.read('core')).history.exitsMs).toEqual([60000]);
  });
  it.each(['generation', 'release', 'future', 'stale'])('rejects %s evidence without advertising readiness', async variant => {
    const f = await fixture(100000);
    f.clock.time = 40000;
    f.deps.core.probe = async c => ({ ...f.evidence(c.generation),
      ...(variant === 'generation' ? { generation: 'wrong' } : {}),
      ...(variant === 'release' ? { releaseDigest: 'c'.repeat(64) } : {}),
      ...(variant === 'future' ? { observedAtMs: f.clock.time + 1 } : {}),
      ...(variant === 'stale' ? { observedAtMs: f.clock.time - 30000 } : {}),
    });
    await run(f); expect(f.statuses.some(s => s.state === 'LOCAL_CORE_HEALTHY')).toBe(false);
    expect(f.trace.filter(x => x.startsWith('stop:core'))).toHaveLength(1);
  });
  it.each(['AUTH_BLOCKED', 'TOOL_SURFACE_MISMATCH'] as const)('stops and idles after %s without another authenticated probe', async code => {
    const f = await fixture(); let probes = 0;
    f.deps.core.probe = async c => { probes++; return { ...f.evidence(c.generation), state: 'BLOCKED', code }; };
    expect(await run(f)).toBe(0); expect(probes).toBe(1);
    expect(f.trace.filter(x => x.startsWith('stop:core'))).toHaveLength(1);
    expect(f.statuses.some(s => s.code === code)).toBe(true);
  });
  it('counts an unexpected child exit once and never publishes healthy for a dead child', async () => {
    const f = await fixture(); f.deps.core.spawn = async (_c, g) => ({ ...managed('core', g), exited: Promise.resolve() });
    expect(await run(f)).toBe(1);
    expect((await f.deps.lifecycle.read('core')).history.exitsMs).toEqual([0]);
    expect(f.statuses.some(s => s.state === 'LOCAL_CORE_HEALTHY')).toBe(false);
  });
  it('aborts before any generation, history mutation or process action', async () => {
    const f = await fixture(); const before = Buffer.from(f.circuit.data.get('core') ?? []);
    f.controller.abort(); expect(await run(f)).toBe(0); expect(f.trace).toEqual([]);
    expect(f.circuit.data.get('core')?.equals(before)).toBe(true);
  });
  it('does not initialize or overwrite missing/corrupt history', async () => {
    for (const bytes of [null, Buffer.from('SYNTHETIC_SECRET')]) {
      const f = await fixture(); if (bytes === null) f.circuit.data.delete('core'); else f.circuit.data.set('core', bytes);
      expect(await run(f)).toBe(0);
      expect(f.trace).not.toContain('spawn:core'); expect(f.trace).not.toContain('generation');
      expect(f.circuit.data.get('core') ?? null).toEqual(bytes);
      expect(JSON.stringify(f.statuses)).not.toContain('SYNTHETIC_SECRET');
    }
  });
  it('preserves a prior active marker unless independent stopped proof is available', async () => {
    const f = await fixture(); const s = await f.deps.lifecycle.read('core');
    await f.deps.lifecycle.write('core', s, { kind: 'begin', generation: 'previous', nowMs: 0 });
    expect(await run(f)).toBe(0); expect(f.trace).not.toContain('spawn:core');
    expect((await f.deps.lifecycle.read('core')).history.activeAttempt?.generation).toBe('previous');
  });
  it('counts an independently stopped prior attempt as the fifth crash and keeps the block sticky', async () => {
    const f = await fixture(); let s = await f.deps.lifecycle.read('core');
    for (let i = 0; i < 4; i++) {
      s = await f.deps.lifecycle.write('core', s, { kind: 'begin', generation: `old-${i}`, nowMs: 0 });
      s = await f.deps.lifecycle.write('core', s, { kind: 'exit', generation: `old-${i}`, nowMs: 0, intentional: false });
    }
    await f.deps.lifecycle.write('core', s, { kind: 'begin', generation: 'crashed-supervisor', nowMs: 0 });
    (f.deps as SupervisorDeps & { confirmStopped: () => Promise<boolean> }).confirmStopped = async () => true;
    expect(await run(f)).toBe(0); expect(f.trace).not.toContain('generation');
    const h = (await f.deps.lifecycle.read('core')).history;
    expect(h.blocked).toBe(true); expect(h.exitsMs).toHaveLength(5); expect(h.activeAttempt).toBeNull();
  });
  it('stops a child returned during cancellation using a fresh non-aborted stop signal', async () => {
    const f = await fixture();
    f.deps.core.spawn = async (_c, g) => { f.controller.abort(); return managed('core', g); };
    expect(await run(f)).toBe(0); expect(f.trace).toContain('stop:core:20000:false');
    expect((await f.deps.lifecycle.read('core')).history.activeAttempt).toBeNull();
  });
  it('keeps the active marker after unconfirmed shutdown and suppresses raw errors', async () => {
    const f = await fixture(1); f.deps.core.stop = async () => { throw new Error('SYNTHETIC_SECRET'); };
    expect(await run(f)).toBe(1);
    expect((await f.deps.lifecycle.read('core')).history.activeAttempt).not.toBeNull();
    expect(f.statuses.at(-1)?.state).not.toBe('STOPPED');
    expect(JSON.stringify(f.statuses)).not.toContain('SYNTHETIC_SECRET');
  });
  it('caps a non-cooperative stop at twenty seconds and does not clear its marker', async () => {
    vi.useFakeTimers(); const f = await fixture(1); f.deps.core.stop = async () => new Promise<void>(() => {});
    const pending = run(f); await vi.advanceTimersByTimeAsync(0); await vi.advanceTimersByTimeAsync(20000);
    expect(await pending).toBe(1); expect((await f.deps.lifecycle.read('core')).history.activeAttempt).not.toBeNull();
  });
});

describe('transport supervision stays separate from core and credentials', () => {
  it.each(['missing', 'mismatch'])('blocks %s compatibility without credential access', async variant => {
    const f = await fixture(); f.deps.tunnel.compatibility = async () => variant === 'missing' ? null : { digest };
    expect(await run(f, 'tunnel')).toBe(0); expect(f.trace).not.toContain('credential');
    expect(f.trace).not.toContain('spawn:tunnel');
    expect(f.statuses.some(s => s.code === 'TUNNEL_COMPATIBILITY_REQUIRED')).toBe(true);
  });
  it('blocks a missing credential without retrying it or starting a tunnel', async () => {
    const f = await fixture(); let reads = 0; f.deps.tunnel.credentialAvailable = async () => { reads++; return false; };
    expect(await run(f, 'tunnel')).toBe(0); expect(reads).toBe(1); expect(f.trace).not.toContain('spawn:tunnel');
  });
  it('does not restart either process solely because transport is offline', async () => {
    const f = await fixture(20000); f.deps.tunnel.probe = async () => 'OFFLINE';
    expect(await run(f, 'tunnel')).toBe(0); expect(f.trace).not.toContain('spawn:core');
    expect(f.trace.filter(x => x === 'spawn:tunnel')).toHaveLength(1);
    expect(f.statuses.some(s => s.state === 'OFFLINE')).toBe(true);
    expect(f.statuses.some(s => s.state === 'TRANSPORT_READY')).toBe(false);
    expect((await f.deps.lifecycle.read('tunnel')).history.exitsMs).toEqual([]);
  });
  it('stops the owned tunnel on core generation change before accepting another transport observation', async () => {
    const f = await fixture(); f.deps.currentCore = async () => f.evidence(f.clock.time === 0 ? 'before' : 'after');
    expect(await run(f, 'tunnel')).toBe(1);
    expect(f.trace.filter(x => x === 'probe:tunnel')).toHaveLength(1);
    expect(f.trace.filter(x => x.startsWith('stop:tunnel'))).toHaveLength(1);
    expect((await f.deps.lifecycle.read('tunnel')).history.exitsMs).toEqual([]);
  });
  it('rechecks core after credential availability and never spawns against stale evidence', async () => {
    const f = await fixture(); let available = true;
    f.deps.currentCore = async () => available ? f.evidence() : null;
    f.deps.tunnel.credentialAvailable = async () => { available = false; return true; };
    expect(await run(f, 'tunnel')).toBe(0); expect(f.trace).not.toContain('spawn:tunnel');
  });
  it('stops and blocks rejected credentials rather than retrying authentication', async () => {
    const f = await fixture(); let probes = 0; f.deps.tunnel.probe = async () => { probes++; return 'AUTH_BLOCKED'; };
    expect(await run(f, 'tunnel')).toBe(0); expect(probes).toBe(1);
    expect(f.trace.filter(x => x.startsWith('stop:tunnel'))).toHaveLength(1);
    expect(f.statuses.some(s => s.state === 'AUTH_BLOCKED')).toBe(true);
  });
  it('rejects unknown provider states instead of treating truthy values as ready', async () => {
    const f = await fixture(); f.deps.tunnel.probe = async () => 'UNKNOWN';
    expect(await run(f, 'tunnel')).toBe(0); expect(f.statuses.some(s => s.state === 'TRANSPORT_READY')).toBe(false);
  });
  it('rejects invalid configuration before consulting native or credential ports', async () => {
    const f = await fixture();
    expect(await runSupervisor('core', { ...labConfig(), mode: 'PRODUCTION' } as unknown as ServiceConfig,
      f.deps, f.controller.signal)).toBe(0);
    expect(f.trace).toEqual([]);
  });
});
