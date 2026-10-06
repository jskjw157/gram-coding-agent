import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { parseConfig } from './config.js';
import type { Clock, OwnedChild, Role } from './contracts.js';
import { LifecycleStore, type CircuitFiles } from './lifecycle-store.js';
import { TelemetryStore, type RecordFiles } from './telemetry-store.js';
import { dependencyDelayMs, runSupervisor, type ManagedChild, type SupervisorDeps } from './supervisor.js';

const releaseDigest = 'a'.repeat(64);
function labConfig(tunnel = false) {
  return parseConfig({ schemaVersion: 1, mode: 'LAB_ONLY', runtimeUser: 'gram-agent',
    releaseId: 'lab-001', releaseDigest, tunnel: tunnel
      ? { enabled: true, compatibilityDigest: 'b'.repeat(64), credentialRef: 'test-tunnel-key' }
      : { enabled: false } });
}
class MemoryCircuit implements CircuitFiles {
  data = new Map<Role, Buffer>(); trace: string[] = [];
  async read(role: Role) { const value = this.data.get(role); return value ? Buffer.from(value) : null; }
  async compareAndSwap(role: Role, expected: string | null, bytes: Buffer) {
    const current = this.data.get(role);
    const actual = current ? createHash('sha256').update(current).digest('hex') : null;
    if (actual !== expected) throw new Error('STATE_CONFLICT');
    this.trace.push(`circuit:${role}`); this.data.set(role, Buffer.from(bytes));
  }
}
class MemoryRecords implements RecordFiles {
  data = new Map<Role, (Buffer | null)[]>();
  constructor(private readonly size: 1 | 3) {}
  async read(role: Role) {
    const value = this.data.get(role) ?? Array.from({ length: this.size }, () => null);
    return value.map(item => item === null ? null : Buffer.from(item));
  }
  async compareAndSwap(role: Role, expected: readonly (string | null)[], slot: number, bytes: Buffer) {
    const current = await this.read(role);
    const actual = current.map(item => item === null ? null : createHash('sha256').update(item).digest('hex'));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('STATE_CONFLICT');
    current[slot] = Buffer.from(bytes); this.data.set(role, current);
  }
}
class FakeClock implements Clock {
  now = 0; delays: number[] = [];
  constructor(private readonly stopAt: number, private readonly controller: AbortController) {}
  nowMs() { return this.now; }
  async sleep(ms: number, signal: AbortSignal) {
    if (signal.aborted) throw new Error('ABORTED');
    this.delays.push(ms); this.now += ms;
    if (this.now >= this.stopAt) this.controller.abort();
  }
}
function child(role: Role, generation: string): OwnedChild {
  return { role, pid: 4242, uid: 501, startIdentity: '1.1', generation, releaseDigest };
}
function managed(role: Role, generation: string): ManagedChild {
  return { child: child(role, generation), exited: new Promise<void>(() => {}) };
}
async function fixture(input: { blocked?: boolean; stopAt?: number; coreAvailable?: boolean } = {}) {
  const controller = new AbortController(); const circuit = new MemoryCircuit();
  const lifecycle = new LifecycleStore(circuit);
  await lifecycle.initializeNew('core', 0); await lifecycle.initializeNew('tunnel', 0);
  if (input.blocked) {
    let snap = await lifecycle.read('core');
    for (let i = 0; i < 5; i++) {
      const generation = `old-${i}`;
      snap = await lifecycle.write('core', snap, { kind: 'begin', generation, nowMs: i * 2 + 1 });
      snap = await lifecycle.write('core', snap, { kind: 'exit', generation, nowMs: i * 2 + 2, intentional: false });
    }
  }
  circuit.trace.length = 0;
  const clock = new FakeClock(input.stopAt ?? 10000, controller);
  const trace: string[] = []; let sequence = 0; let coreSpawns = 0; let tunnelSpawns = 0;
  const evidence = (generation = 'core-existing') => ({ state: 'LOCAL_CORE_HEALTHY' as const, code: 'OK' as const,
    generation, releaseDigest, observedAtMs: clock.nowMs() });
  const deps: SupervisorDeps = {
    clock, lifecycle, telemetry: new TelemetryStore(new MemoryRecords(1), new MemoryRecords(3)),
    nextGeneration(role) { const value = `${role}-g-${++sequence}`; trace.push(`generation:${value}`); return value; },
    core: {
      async spawn(_config, generation) { coreSpawns++; trace.push('spawn:core'); return managed('core', generation); },
      async probe(item) { trace.push('probe:core'); return evidence(item.generation); },
      async stop() { trace.push('stop:core'); },
    },
    async currentCore() { trace.push('current:core'); return input.coreAvailable === false ? null : evidence(); },
    tunnel: {
      async compatibility() { trace.push('compatibility'); return { digest: 'b'.repeat(64) }; },
      async credentialAvailable() { trace.push('credential'); return true; },
      async spawn(_config, _compatibility, _core, generation) {
        tunnelSpawns++; trace.push('spawn:tunnel'); return managed('tunnel', generation);
      },
      async probe() { trace.push('probe:tunnel'); return 'READY'; },
      async stop() { trace.push('stop:tunnel'); },
    },
  };
  return { controller, circuit, clock, trace, deps, coreSpawns: () => coreSpawns, tunnelSpawns: () => tunnelSpawns };
}

describe('bounded dependency backoff', () => {
  it('uses 1,2,4,8,16 then capped 30 second delays', () => {
    expect(Array.from({ length: 10 }, (_, i) => dependencyDelayMs(i)))
      .toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000]);
  });
  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid attempt %s', value => {
    expect(() => dependencyDelayMs(value)).toThrow(/^INVALID_HISTORY$/);
  });
});

describe('supervisor pre-spawn ordering', () => {
  it('persists a core begin marker before spawn', async () => {
    const f = await fixture({ stopAt: 1 });
    f.deps.core.spawn = async (_config, generation) => {
      expect(f.circuit.trace.length).toBeGreaterThan(0);
      const history = await f.deps.lifecycle.read('core');
      expect(history.history.activeAttempt?.generation).toBe(generation);
      throw new Error('synthetic spawn failure');
    };
    expect(await runSupervisor('core', labConfig(), f.deps, f.controller.signal)).toBe(1);
  });

  it('keeps a restart-budget-blocked core idle without spawning', async () => {
    const f = await fixture({ blocked: true, stopAt: 5000 });
    expect(await runSupervisor('core', labConfig(), f.deps, f.controller.signal)).toBe(0);
    expect(f.coreSpawns()).toBe(0);
    expect(f.trace.some(item => item.startsWith('generation:'))).toBe(false);
  });

  it('does not spawn a disabled tunnel or touch compatibility/credentials', async () => {
    const f = await fixture();
    expect(await runSupervisor('tunnel', labConfig(false), f.deps, f.controller.signal)).toBe(0);
    expect(f.tunnelSpawns()).toBe(0); expect(f.trace).toEqual([]);
  });

  it('waits for healthy core with capped dependency backoff and does not spawn a tunnel', async () => {
    const f = await fixture({ coreAvailable: false, stopAt: 61000 });
    expect(await runSupervisor('tunnel', labConfig(true), f.deps, f.controller.signal)).toBe(0);
    expect(f.tunnelSpawns()).toBe(0);
    expect(f.clock.delays.slice(0, 6)).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
    expect(f.trace).not.toContain('credential');
  });
});
