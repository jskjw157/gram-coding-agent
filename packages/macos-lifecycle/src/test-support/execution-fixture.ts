import { createHash } from 'node:crypto';
import type { Role } from '../contracts.js';
import type { RecordFiles } from '../telemetry-store.js';
import type { ManagedChild, SupervisorDeps } from '../supervisor.js';
export const releaseDigest = 'a'.repeat(64);
export const configDigest = 'b'.repeat(64);
export class MemoryExecutionFiles implements RecordFiles {
  values = new Map<Role, Buffer>();
  writes = 0;
  async read(role: Role) { const v = this.values.get(role); return [v ? Buffer.from(v) : null]; }
  async compareAndSwap(role: Role, expected: readonly (string | null)[], slot: number, bytes: Buffer) {
    const v = this.values.get(role); const digest = v ? createHash('sha256').update(v).digest('hex') : null;
    if (slot !== 0 || expected.length !== 1 || digest !== expected[0]) throw new Error('STATE_CONFLICT');
    this.values.set(role, Buffer.from(bytes)); this.writes++;
  }
}
export function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('uninitialized'); };
  let reject: (error: Error) => void = () => { throw new Error('uninitialized'); };
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject };
}
export function labConfig() {
  return { schemaVersion: 1 as const, mode: 'LAB_ONLY' as const, runtimeUser: 'gram-agent' as const,
    releaseId: 'lab-001', releaseDigest, tunnel: { enabled: false as const } };
}
export function controlledCore() {
  const exit = deferred<undefined>(); let launches = 0; let stops = 0;
  let current: ManagedChild | null = null;
  const port: SupervisorDeps['core'] = {
    async spawn(_config, generation) {
      launches++;
      current = { child: { role: 'core', pid: 4242, uid: 501, startIdentity: '1.1', generation, releaseDigest },
        exited: exit.promise };
      return current;
    },
    async probe() { return { state: 'UNKNOWN', code: 'HEALTH_UNKNOWN', generation: '', releaseDigest: '', observedAtMs: 0 }; },
    async stop() { stops++; exit.resolve(undefined); await exit.promise; },
  };
  return { port, exit, launches: () => launches, stops: () => stops, current: () => current };
}
