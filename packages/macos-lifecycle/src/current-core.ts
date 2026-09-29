import type { Socket } from 'node:net';
import type { ServiceConfig, OwnedChild } from './contracts.js';
import { configDigest, parseConfig } from './config.js';
import { coreStartIdentity, decodeCoreRegistration, encodeCoreRegistration, matchesCoreExecution,
  type CoreRegistrationStore } from './core-registration.js';
import { decodeExecution, encodeExecution, type ExecutionLeaseStore } from './execution-lease.js';
import { abortable, copyCoreChild, probeCore, type CoreConnections, type CoreCredentials, type CoreEvidence } from './health-probe.js';
import { currentStatus, type ServiceStatus } from './telemetry.js';
import type { CoreAuthority } from './adapters/native-core.js';
import { createLoopbackConnections, type ConnectedPeerVerifier } from './adapters/loopback-http.js';
import type { NativeProcessIdentity } from './adapters/owned-process.js';

/** Trusted local dependencies. Test connections are not a configuration option. */
export interface CurrentCoreDeps {
  registration: Pick<CoreRegistrationStore, 'read'>;
  execution: Pick<ExecutionLeaseStore, 'read'>;
  status(): Promise<ServiceStatus | null>;
  authority: CoreAuthority;
  credentials: CoreCredentials;
  now?(): number;
  connections?(verifier: ConnectedPeerVerifier): CoreConnections;
}
function refuse(): never { throw new Error('HEALTH_UNKNOWN'); }
function sameChild(a: OwnedChild, b: OwnedChild): boolean {
  try { return JSON.stringify(copyCoreChild(a)) === JSON.stringify(copyCoreChild(b)); } catch { return false; }
}
function tuple(socket: Socket): { serverPort: number; clientPort: number } | null {
  if (socket.localAddress !== '127.0.0.1' || socket.remoteAddress !== '127.0.0.1' || socket.remotePort !== 3847
    || !Number.isSafeInteger(socket.localPort) || (socket.localPort ?? 0) < 1 || (socket.localPort ?? 0) > 65535) return null;
  return { serverPort: 3847, clientPort: socket.localPort as number };
}
/** Independent observer: the recorded child is NOT represented as a fabricated
 * ChildProcess. It is matched against libproc on the actual connected socket.
 * All calls are read-only except local credential use for existing health RPCs.
 */
export function createCurrentCoreReader(input: ServiceConfig, deps: CurrentCoreDeps):
  (signal: AbortSignal) => Promise<CoreEvidence | null> {
  let config: ServiceConfig;
  try { config = parseConfig(input); Object.freeze(config.tunnel); Object.freeze(config); }
  catch { return async () => null; }
  const wantedDigest = configDigest(config);
  return async parent => {
    const deadline = new AbortController(); const timer = setTimeout(() => deadline.abort(), 10000);
    const signal = AbortSignal.any([parent, deadline.signal]); let lastTime = -1;
    const check = (active: AbortSignal = signal) => { if (active.aborted || signal.aborted) refuse(); };
    const now = () => {
      const value = deps.now ? deps.now() : Date.now();
      if (!Number.isSafeInteger(value) || value < 0 || value < lastTime) refuse(); lastTime = value; return value;
    };
    try {
      check();
      const source = await abortable(deps.registration.read(), signal); check();
      if (source === null) return null;
      const record = decodeCoreRegistration(encodeCoreRegistration(source));
      if (record.configDigest !== wantedDigest || record.child.releaseDigest !== config.releaseDigest) return null;
      const expected = encodeCoreRegistration(record); const owner = record.child;
      const consistent = async (active: AbortSignal): Promise<boolean> => {
        try {
          check(active);
          const r = await abortable(deps.registration.read(), active); check(active);
          if (r === null || !expected.equals(encodeCoreRegistration(r))) return false;
          const held = decodeExecution(encodeExecution(await abortable(deps.execution.read('core'), active))); check(active);
          if (!matchesCoreExecution(record, held)) return false;
          const status = currentStatus(await abortable(deps.status(), active),
            { role: 'core', generation: owner.generation, releaseDigest: owner.releaseDigest }, now());
          check(active); return status?.state === 'LOCAL_CORE_HEALTHY' && status.code === 'OK';
        } catch { return false; }
      };
      if (!await consistent(signal)) return null;
      const grant = await abortable(deps.authority.acquire(config, signal), signal); check();
      if (!grant || grant.configDigest !== wantedDigest || grant.account?.name !== 'gram-agent'
        || grant.account.uid !== owner.uid || grant.account.admin !== false || !Number.isSafeInteger(grant.account.gid)
        || grant.account.gid < 0 || !grant.proof || typeof grant.proof.current !== 'function' || typeof grant.proof.peer !== 'function'
        || !grant.executable || typeof grant.executable.dev !== 'bigint' || typeof grant.executable.ino !== 'bigint'
        || grant.executable.dev < 0n || grant.executable.ino < 1n
        || grant.executable.dev > 0xffff_ffff_ffff_ffffn || grant.executable.ino > 0xffff_ffff_ffff_ffffn) return null;
      const start = coreStartIdentity(owner.startIdentity);
      const identity: NativeProcessIdentity = Object.freeze({ pid: owner.pid, uid: owner.uid,
        startSec: start.sec, startUsec: start.usec, executable: Object.freeze({ ...grant.executable }) });
      const nativeCurrent = grant.proof.current.bind(grant.proof); const nativePeer = grant.proof.peer.bind(grant.proof);
      const current = async (child: OwnedChild, active: AbortSignal = signal): Promise<boolean> => {
        try {
          if (!sameChild(child, owner) || !await consistent(active)) return false;
          if (await abortable(nativeCurrent(identity, active), active) !== 'OWNED') return false;
          return await consistent(active);
        } catch { return false; }
      };
      const verifier: ConnectedPeerVerifier = Object.freeze<ConnectedPeerVerifier>({
        current: child => current(child),
        async verify(socket, child, requestSignal) {
          const active = AbortSignal.any([signal, requestSignal]); const ports = tuple(socket);
          if (!ports || !await current(child, active)) return 'UNKNOWN';
          try {
            const verdict = await abortable(nativePeer(Object.freeze({ ...identity, ...ports }), active), active);
            if (verdict !== 'OWNED') return verdict === 'FOREIGN' ? 'FOREIGN' : 'UNKNOWN';
            const after = tuple(socket);
            return after?.clientPort === ports.clientPort && await current(child, active) ? 'OWNED' : 'UNKNOWN';
          } catch { return 'UNKNOWN'; }
        },
      });
      if (!await current(owner)) return null;
      const guarded: CoreCredentials = {
        async withValue<T>(use: (secret: string) => Promise<T>): Promise<T> {
          if (!await current(owner)) refuse(); let used = false;
          return deps.credentials.withValue(async secret => {
            if (used || !await current(owner)) refuse(); used = true;
            return use(secret);
          });
        },
      };
      const connections = deps.connections ? deps.connections(verifier) : createLoopbackConnections(verifier);
      const result = await abortable(probeCore(owner, connections, guarded, { signal, now }), signal);
      if (!await current(owner) || result.state !== 'LOCAL_CORE_HEALTHY' || result.code !== 'OK') return null;
      check(); return Object.freeze({ ...result });
    } catch { return null; }
    finally { clearTimeout(timer); deadline.abort(); }
  };
}
