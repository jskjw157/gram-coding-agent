import { createHash } from 'node:crypto';
import { parseConfig } from '../config.js';
import type { Clock, OwnedChild, Role } from '../contracts.js';
import type { CoreEvidence } from '../health-probe.js';
import { LifecycleStore, type CircuitFiles } from '../lifecycle-store.js';
import { TelemetryStore, type RecordFiles } from '../telemetry-store.js';
import { decodeStatus, type ServiceStatus } from '../telemetry.js';
import type { ManagedChild, SupervisorDeps } from '../supervisor.js';
export const digest = 'a'.repeat(64);
const hash = (bytes: Buffer | null) => bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
export function labConfig(enabled = false) {
  return parseConfig({ schemaVersion: 1, mode: 'LAB_ONLY', runtimeUser: 'gram-agent', releaseId: 'lab-001',
    releaseDigest: digest, tunnel: enabled ? { enabled: true, compatibilityDigest: 'b'.repeat(64),
      credentialRef: 'test-tunnel-key' } : { enabled: false } });
}
class MemoryCircuit implements CircuitFiles {
  data = new Map<Role, Buffer>();
  async read(role: Role) { const b = this.data.get(role); return b ? Buffer.from(b) : null; }
  async compareAndSwap(role: Role, expected: string | null, bytes: Buffer) {
    if (hash(this.data.get(role) ?? null) !== expected) throw new Error('STATE_CONFLICT');
    this.data.set(role, Buffer.from(bytes));
  }
}
class Records implements RecordFiles {
  data = new Map<Role, (Buffer | null)[]>(); statuses: ServiceStatus[] = [];
  constructor(private readonly size: number) {}
  async read(role: Role) { return (this.data.get(role) ?? Array<null>(this.size).fill(null))
    .map(b => b === null ? null : Buffer.from(b)); }
  async compareAndSwap(role: Role, expected: readonly (string | null)[], slot: number, bytes: Buffer) {
    const previous = await this.read(role);
    if (JSON.stringify(previous.map(hash)) !== JSON.stringify(expected)) throw new Error('STATE_CONFLICT');
    previous[slot] = Buffer.from(bytes); this.data.set(role, previous);
    if (this.size === 1) this.statuses.push(decodeStatus(bytes));
  }
}
export function managed(role: Role, generation: string): ManagedChild {
  const child: OwnedChild = { role, generation, releaseDigest: digest, pid: 4242, uid: 501, startIdentity: '1.1' };
  return { child, exited: new Promise<void>(() => {}) };
}
export async function fixture(stopAt = 10000) {
  const controller = new AbortController(); const circuit = new MemoryCircuit();
  const lifecycle = new LifecycleStore(circuit); const records = new Records(1);
  await lifecycle.initializeNew('core', 0); await lifecycle.initializeNew('tunnel', 0);
  const clock: Clock & { time: number; delays: number[] } = {
    time: 0, delays: [], nowMs() { return this.time; },
    async sleep(ms, signal) {
      if (signal.aborted) throw new Error('ABORTED');
      this.delays.push(ms); this.time += ms;
      if (this.time >= stopAt) controller.abort();
    },
  };
  let count = 0; const trace: string[] = [];
  const evidence = (generation = 'existing-core'): CoreEvidence => ({
    state: 'LOCAL_CORE_HEALTHY', code: 'OK', generation, releaseDigest: digest, observedAtMs: clock.time,
  });
  const deps: SupervisorDeps = {
    clock, lifecycle, telemetry: new TelemetryStore(records, new Records(3)),
    nextGeneration(role) { trace.push('generation'); return `${role}-${++count}`; },
    core: {
      async spawn(_config, generation) { trace.push('spawn:core'); return managed('core', generation); },
      async probe(child) { trace.push('probe:core'); return evidence(child.generation); },
      async stop(_child, deadline, signal) { trace.push(`stop:core:${deadline}:${signal.aborted}`); },
    },
    async currentCore() { trace.push('current:core'); return evidence(); },
    tunnel: {
      async compatibility() { trace.push('compatibility'); return { digest: 'b'.repeat(64) }; },
      async credentialAvailable() { trace.push('credential'); return true; },
      async spawn(_config, _proof, _core, generation) { trace.push('spawn:tunnel'); return managed('tunnel', generation); },
      async probe() { trace.push('probe:tunnel'); return 'READY'; },
      async stop(_child, deadline, signal) { trace.push(`stop:tunnel:${deadline}:${signal.aborted}`); },
    },
  };
  return { controller, circuit, clock, trace, deps, evidence, statuses: records.statuses };
}
