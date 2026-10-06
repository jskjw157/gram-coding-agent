import { configDigest, parseConfig } from './config.js';
import { coreStartIdentity, encodeCoreRegistration, matchesCoreExecution,
  type CoreRegistrationStore } from './core-registration.js';
import type { Role, ServiceConfig } from './contracts.js';
import { encodeExecution, type ExecutionLeaseStore, type ExecutionRecord } from './execution-lease.js';
import { encodeTunnelRegistration, matchesTunnelExecution,
  type TunnelRegistrationStore } from './tunnel-registration.js';
import type { ExecutableIdentity, NativePeerProofPort } from './adapters/owned-process.js';

export interface StoppedRecoveryDeps {
  config: ServiceConfig;
  execution: ExecutionLeaseStore;
  coreRegistration: Pick<CoreRegistrationStore,'read'>;
  tunnelRegistration: Pick<TunnelRegistrationStore,'read'> | null;
  proof: NativePeerProofPort;
  executable(role: Role, signal: AbortSignal): Promise<ExecutableIdentity | null>;
}

function executable(value: ExecutableIdentity | null): value is ExecutableIdentity {
  return value !== null && typeof value === 'object'
    && typeof value.dev === 'bigint' && typeof value.ino === 'bigint'
    && value.dev >= 0n && value.ino > 0n
    && value.dev <= 0xffff_ffff_ffff_ffffn && value.ino <= 0xffff_ffff_ffff_ffffn;
}

/**
 * Read-only proof that the reviewed execution identity is no longer current.
 *
 * Unlike createStoppedRecovery(), this function NEVER changes the execution
 * lease. It is used by reset-failure so restart-budget state can be cleared
 * while HELD/revision evidence remains intact for later recovery/audit.
 */
export function createStoppedProof(input: StoppedRecoveryDeps):
  (role: Role, signal: AbortSignal) => Promise<boolean> {
  const config = parseConfig(input.config);
  const wanted = configDigest(config);
  const execution = input.execution;
  const coreRegistration = input.coreRegistration;
  const tunnelRegistration = input.tunnelRegistration;
  const proof = input.proof;
  const getExecutable = input.executable.bind(input);

  return async (role, signal) => {
    try {
      if ((role !== 'core' && role !== 'tunnel') || signal.aborted) return false;
      const snapshot = await execution.read(role);
      if (snapshot.state === 'FREE') return !signal.aborted;
      if (snapshot.configDigest !== wanted || snapshot.releaseDigest !== config.releaseDigest) return false;

      const registration = role === 'core'
        ? await coreRegistration.read()
        : await tunnelRegistration?.read() ?? null;
      if (registration === null) return false;
      const matched = role === 'core'
        ? registration.role === 'core' && matchesCoreExecution(registration, snapshot)
        : registration.role === 'tunnel' && matchesTunnelExecution(registration, snapshot);
      if (!matched) return false;

      const before = role === 'core'
        ? encodeCoreRegistration(registration)
        : encodeTunnelRegistration(registration);
      const start = coreStartIdentity(registration.child.startIdentity);
      const image = await getExecutable(role, signal);
      if (!executable(image) || signal.aborted) return false;
      const identity = Object.freeze({
        pid: registration.child.pid,
        uid: registration.child.uid,
        startSec: start.sec,
        startUsec: start.usec,
        executable: Object.freeze({ dev: image.dev, ino: image.ino }),
      });
      if (await proof.current(identity, signal) !== 'FOREIGN' || signal.aborted) return false;

      const afterRegistration = role === 'core'
        ? await coreRegistration.read()
        : await tunnelRegistration?.read() ?? null;
      if (afterRegistration === null) return false;
      const afterBytes = role === 'core'
        ? afterRegistration.role === 'core' ? encodeCoreRegistration(afterRegistration) : null
        : afterRegistration.role === 'tunnel' ? encodeTunnelRegistration(afterRegistration) : null;
      if (afterBytes === null || !afterBytes.equals(before)) return false;

      const afterExecution = await execution.read(role);
      return encodeExecution(afterExecution).equals(encodeExecution(snapshot)) && !signal.aborted;
    } catch {
      return false;
    }
  };
}

export function createStoppedRecovery(input: StoppedRecoveryDeps):
  (role: Role, signal: AbortSignal) => Promise<boolean> {
  const config = parseConfig(input.config);
  const wanted = configDigest(config);
  const execution = input.execution;
  const coreRegistration = input.coreRegistration;
  const tunnelRegistration = input.tunnelRegistration;
  const proof = input.proof;
  const getExecutable = input.executable.bind(input);

  return async (role, signal) => {
    try {
      if ((role !== 'core' && role !== 'tunnel') || signal.aborted) return false;
      const snapshot = await execution.read(role);
      if (snapshot.state === 'FREE') return !signal.aborted;
      if (snapshot.configDigest !== wanted || snapshot.releaseDigest !== config.releaseDigest) return false;

      const registration = role === 'core'
        ? await coreRegistration.read()
        : await tunnelRegistration?.read() ?? null;
      if (registration === null) return false;
      const matched = role === 'core'
        ? registration.role === 'core' && matchesCoreExecution(registration, snapshot)
        : registration.role === 'tunnel' && matchesTunnelExecution(registration, snapshot);
      if (!matched) return false;

      const before = role === 'core'
        ? encodeCoreRegistration(registration)
        : encodeTunnelRegistration(registration);
      const start = coreStartIdentity(registration.child.startIdentity);

      await execution.recoverStopped(role, async (record: Readonly<ExecutionRecord>) => {
        if (signal.aborted) return false;
        const sameRecord = role === 'core'
          ? registration.role === 'core' && matchesCoreExecution(registration, record)
          : registration.role === 'tunnel' && matchesTunnelExecution(registration, record);
        if (!sameRecord) return false;

        const image = await getExecutable(role, signal);
        if (!executable(image) || signal.aborted) return false;
        const identity = Object.freeze({
          pid: registration.child.pid, uid: registration.child.uid,
          startSec: start.sec, startUsec: start.usec,
          executable: Object.freeze({ dev: image.dev, ino: image.ino }),
        });
        if (await proof.current(identity, signal) !== 'FOREIGN' || signal.aborted) return false;

        const after = role === 'core'
          ? await coreRegistration.read()
          : await tunnelRegistration?.read() ?? null;
        if (after === null) return false;
        const bytes = role === 'core'
          ? after.role === 'core' ? encodeCoreRegistration(after) : null
          : after.role === 'tunnel' ? encodeTunnelRegistration(after) : null;
        return bytes !== null && bytes.equals(before);
      });
      return !signal.aborted;
    } catch {
      return false;
    }
  };
}
