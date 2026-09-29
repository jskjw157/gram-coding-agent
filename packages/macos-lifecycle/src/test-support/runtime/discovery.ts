import { createHash } from 'node:crypto';
import type { Socket } from 'node:net';
import { configDigest } from '../../config.js';
import type { OwnedChild, ServiceConfig } from '../../contracts.js';
import { CoreRegistrationStore } from '../../core-registration.js';
import { ExecutionLeaseStore } from '../../execution-lease.js';
import type { RecordFiles } from '../../telemetry-store.js';
import type { ServiceStatus } from '../../telemetry.js';
import { CORE_PROTOCOL, type CoreRequest, type WireReply } from '../../health-probe.js';
import type { CurrentCoreDeps } from '../../current-core.js';
import type { NativePeerProofPort } from '../../adapters/owned-process.js';
export const digest = 'a'.repeat(64);
export const signal = () => new AbortController().signal;
export const config = (): ServiceConfig => ({ schemaVersion: 1, mode: 'LAB_ONLY', runtimeUser: 'gram-agent',
  releaseId: 'lab-001', releaseDigest: digest, tunnel: { enabled: false } });
export function child(generation = 'g1'): OwnedChild {
  return { role: 'core', pid: 4242, uid: 501, startIdentity: '1700000000.123456', generation, releaseDigest: digest };
}
export function memoryFiles() {
  const values = new Map<string, Buffer>(); let writes = 0;
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const files: RecordFiles = {
    async read(role) { const b = values.get(role); return [b ? Buffer.from(b) : null]; },
    async compareAndSwap(role, expected, slot, bytes) {
      const old = values.get(role);
      if (slot !== 0 || expected.length !== 1 || expected[0] !== (old ? hash(old) : null)) throw new Error('STATE_CONFLICT');
      values.set(role, Buffer.from(bytes)); writes++;
    },
  };
  return { files, values, writes: () => writes };
}
const health = { status: 'healthy', database: 'ok', mcp: 'ready' };
export function reply(kind: CoreRequest): WireReply {
  const result = kind === 'initialize' ? { protocolVersion: CORE_PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'gram-coding-agent' } }
    : kind === 'tools' ? { tools: [{ name: 'agent_health' }] }
    : { content: [{ type: 'text', text: JSON.stringify(health) }] };
  return { status: kind === 'initialized' ? 202 : 200, contentType: 'application/json', body: kind === 'initialized' ? Buffer.alloc(0)
    : Buffer.from(JSON.stringify(kind === 'health' ? health : { jsonrpc: '2.0', id: kind === 'initialize' ? 1 : kind === 'tools' ? 2 : 3, result })) };
}
export async function discoveryFixture() {
  const executionBytes = memoryFiles(); const recordBytes = memoryFiles();
  const execution = new ExecutionLeaseStore(executionBytes.files); await execution.initializeNew('core');
  const lease = await execution.acquire('core', 'g1', configDigest(config()), digest);
  const registration = new CoreRegistrationStore(recordBytes.files, execution);
  await registration.publish(config(), child());
  const trace: string[] = []; const sent: CoreRequest[] = [];
  let clock = 1000; let secretUses = 0; let statusReads = 0;
  let status: ServiceStatus = { schemaVersion: 1, role: 'core', generation: 'g1', releaseDigest: digest,
    state: 'LOCAL_CORE_HEALTHY', code: 'OK', observedAtMs: 1000, attemptCount: 0 };
  const proof: NativePeerProofPort = {
    async capture() { throw new Error('observer must not rebase a recorded process start'); },
    async current(request) { trace.push(`current:${request.pid}:${request.startSec}.${request.startUsec}`); return 'OWNED'; },
    async peer(request) { trace.push(`peer:${request.serverPort}:${request.clientPort}`); return 'OWNED'; },
  };
  const socket = { localAddress: '127.0.0.1', remoteAddress: '127.0.0.1', localPort: 51000, remotePort: 3847 } as Socket;
  const deps: CurrentCoreDeps = {
    registration, execution, now: () => clock,
    async status() { statusReads++; return structuredClone(status); },
    authority: { async acquire(c) { trace.push('authority'); return { configDigest: configDigest(c),
      account: { name: 'gram-agent', uid: 501, gid: 20, admin: false }, executable: { dev: 11n, ino: 22n }, proof }; } },
    credentials: { async withValue(use) { secretUses++; return use('SYNTHETIC_TEST_CREDENTIAL'); } },
    connections(verifier) {
      return { async openOwnedConnection(owner, _port, abort) {
        trace.push('open');
        if (await verifier.verify(socket, owner, abort) !== 'OWNED') return null;
        return {
          isCurrent: () => Promise.resolve(verifier.current(owner)), close() { trace.push('close'); },
          async request(kind, credentials) {
            if (kind === 'health') { sent.push(kind); return reply(kind); }
            return credentials.withValue(async () => {
              if (!await verifier.current(owner)) throw new Error('HEALTH_UNKNOWN');
              sent.push(kind); return reply(kind);
            });
          },
        };
      } };
    },
  };
  return { execution, executionBytes, recordBytes, registration, lease, deps, proof, trace, sent,
    secretUses: () => secretUses, statusReads: () => statusReads,
    status: () => status, setStatus: (value: ServiceStatus) => { status = value; }, setClock: (value: number) => { clock = value; } };
}
export function deferred() {
  let resolve: () => void = () => {}; let reject: (error: Error) => void = () => {};
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
