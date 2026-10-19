import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { readProof } from './proof-read.js';
import { root } from './contracts.js';
import { createPublishedResumePortsAt, type PublishedResumePins } from './a-published-resume.js';
import { createSystemNativeInstallStorage } from './a-native-storage.js';
import { createSystemLaunchctlRunner, createSystemServiceHandle } from './a-native-services.js';
import { createInstalledRuntimeReviewSource, createSystemBootstrapAclProbe } from './a-system-sources.js';
import { inspectMacAccount } from './adapters/macos-inspection.js';
import { inspectMacPorts, inspectMacRegistry } from './adapters/macos-service-probes.js';
import { inspectRuntimeDirectories } from './adapters/runtime-directories.js';
import { LifecycleStore } from './lifecycle-store.js';
import { createCircuitFilesAt } from './adapters/service-files.js';
import { createExecutionFilesAt } from './adapters/execution-files.js';
import { createCoreProcessFilesAt } from './adapters/core-process-files.js';
import { createTrustedFiles, type AclProbe } from './adapters/trusted-files.js';
import { createNativePeerProof } from './adapters/owned-process.js';
import { launchctlVector, parsePrintState, type LaunchctlObservation } from './adapters/launchctl.js';
import { ExecutionLeaseStore, encodeExecution } from './execution-lease.js';
import {
  CoreRegistrationStore,
  coreStartIdentity,
  encodeCoreRegistration,
  matchesCoreExecution,
} from './core-registration.js';
import { createCoreResumeProof } from './core-resume-proof.js';
import { createCoreStartAttempt } from './core-start-attempt.js';
import type { RecordFiles } from './telemetry-store.js';
import type { FreshPublishedResumePorts } from './published-resume.js';

/** Exact fixed-label association only; never a process-table scan or ownership
 * proof. The native helper independently pins UID/start time/executable later.
 */
export function parseCoreStartJob(
  observation: LaunchctlObservation,
): { state: 'present'; pid: number } | { state: 'absent' } | null {
  const state = parsePrintState('core', observation);
  if (state === 'absent') return { state: 'absent' };
  if (state !== 'present') return null;
  const lines = [...observation.stdout.matchAll(/^\tpid = ([1-9][0-9]{0,9})$/gm)];
  const text = lines[0]?.[1];
  if (lines.length !== 1 || text === undefined) return null;
  const pid = Number(text);
  return Number.isSafeInteger(pid) && pid <= 0x7fff_ffff ? { state: 'present', pid } : null;
}

/** Fixed system composition only. Construction performs no I/O. No CLI/MCP
 * route, permission elevation, arbitrary helper, label, process or key input.
 */
export function createSystemFreshPublishedResumePorts(pins: PublishedResumePins): FreshPublishedResumePorts {
  const acl = createSystemBootstrapAclProbe();
  const releaseDigest = pins.releaseDigest;
  return createPublishedResumePortsAt({
    layout: { anchor: '/', relative: root.slice(1), ownerUid: 0 },
    acl,
    storage: createSystemNativeInstallStorage(acl),
    pins,
    account: inspectMacAccount,
    registry: inspectMacRegistry,
    ports: inspectMacPorts,
    authorizeLocalAdmin: async () =>
      process.platform === 'darwin' &&
      process.arch === 'arm64' &&
      (process.geteuid?.() ?? process.getuid?.() ?? -1) === 0,
    services: createSystemServiceHandle(acl),
    proof: systemCoreProof(acl, releaseDigest),
    startAttempt: createSystemCoreStartAttempt(acl, releaseDigest),
  });
}

async function reviewedSystemContext(acl: AclProbe, releaseDigest: string, signal: AbortSignal) {
  const account = await readProof(signal, () => inspectMacAccount());
  if (!account || account.admin !== false || account.groupsComplete !== true || signal.aborted) return null;
  const layout = { anchor: '/', relative: root.slice(1), ownerUid: 0 };
  const review = await readProof(signal, () =>
    createInstalledRuntimeReviewSource({
      ...layout,
      runtimeUid: account.uid,
      runtimeGid: account.gid,
      acl,
    }).read(signal),
  );
  if (!review || review.config.tunnel.enabled || review.config.releaseDigest !== releaseDigest || signal.aborted)
    return null;
  const directories = await readProof(signal, () => inspectRuntimeDirectories(layout, account.uid, acl, signal));
  const files = createTrustedFiles('/', 0, acl, `${root.slice(1)}/releases/${review.config.releaseId}`);
  const path = join(root, 'releases', review.config.releaseId, 'bin/node');
  const executable = await readProof(signal, () => lstat(path, { bigint: true }));
  if (
    !executable.isFile() ||
    executable.uid !== 0n ||
    executable.nlink !== 1n ||
    (executable.mode & 0o6022n) !== 0n ||
    (executable.mode & 0o111n) === 0n ||
    (await readProof(signal, () => files.hash('bin/node', 256 * 1024 * 1024))) !== review.nodeDigest ||
    (await readProof(signal, () => files.hash('bin/peer-owner', 256 * 1024 * 1024))) !== review.peerOwnerDigest ||
    signal.aborted
  )
    return null;
  const after = await readProof(signal, () => lstat(path, { bigint: true }));
  if (
    executable.dev !== after.dev ||
    executable.ino !== after.ino ||
    executable.ctimeNs !== after.ctimeNs ||
    executable.mtimeNs !== after.mtimeNs ||
    executable.mode !== after.mode ||
    executable.uid !== after.uid ||
    executable.gid !== after.gid ||
    executable.nlink !== after.nlink ||
    executable.size !== after.size ||
    signal.aborted
  )
    return null;
  return {
    account,
    review,
    directories,
    files,
    executable,
    peer: createNativePeerProof(join(root, 'releases', review.config.releaseId, 'bin/peer-owner')),
  };
}
function systemCoreProof(acl: AclProbe, releaseDigest: string) {
  return createCoreResumeProof(async (signal) => {
    const context = await reviewedSystemContext(acl, releaseDigest, signal);
    if (!context) return null;
    const { account, review, directories, files, executable, peer } = context;
    const guard = (raw: RecordFiles, readSignal: AbortSignal): RecordFiles => ({
      async read(role) {
        await readProof(readSignal, () => directories.verify());
        const value = await readProof(readSignal, () => raw.read(role));
        await readProof(readSignal, () => directories.verify());
        return value;
      },
      async compareAndSwap() {
        throw new Error('READ_ONLY');
      },
    });
    // Each call supplies its own observation lifetime. No capability returned
    // from capture retains capture's signal, which is closed on return.
    const executionAt = (readSignal: AbortSignal) =>
      new ExecutionLeaseStore(guard(createExecutionFilesAt(directories.runPolicy), readSignal));
    const registrationAt = (readSignal: AbortSignal) =>
      new CoreRegistrationStore(
        guard(createCoreProcessFilesAt(directories.runPolicy), readSignal),
        executionAt(readSignal),
      );
    const lifecycleAt = (readSignal: AbortSignal) => {
      const raw = createCircuitFilesAt(directories.runPolicy);
      return new LifecycleStore({
        async read(role) {
          await readProof(readSignal, () => directories.verify());
          const value = await readProof(readSignal, () => raw.read(role));
          await readProof(readSignal, () => directories.verify());
          return value;
        },
        async compareAndSwap() {
          throw new Error('READ_ONLY');
        },
      });
    };
    const held = await readProof(signal, () => executionAt(signal).read('core'));
    const registration = await readProof(signal, () => registrationAt(signal).read());
    if (
      held.state !== 'HELD' ||
      held.releaseDigest !== releaseDigest ||
      held.configDigest !== review.configDigest ||
      !registration ||
      registration.child.uid !== account.uid ||
      !matchesCoreExecution(registration, held) ||
      signal.aborted
    )
      return null;
    const start = coreStartIdentity(registration.child.startIdentity);
    const identity = {
      pid: registration.child.pid,
      uid: registration.child.uid,
      startSec: start.sec,
      startUsec: start.usec,
      executable: { dev: executable.dev, ino: executable.ino },
    };
    return {
      held: encodeExecution(held),
      registration: encodeCoreRegistration(registration),
      revision: held.revision,
      generation: registration.child.generation,
      identity,
      peer,
      files,
      helperDigest: review.peerOwnerDigest,
      nodeDigest: review.nodeDigest,
      execution: { read: (role, readSignal) => executionAt(readSignal).read(role) },
      registrationStore: { read: (readSignal) => registrationAt(readSignal).read() },
      lifecycle: { read: (role, readSignal) => lifecycleAt(readSignal).read(role) },
      verify: (readSignal) => readProof(readSignal, () => directories.verify()),
    };
  });
}

/** Internal CI/native composition seam; fixed label and paths only. */
export function createSystemCoreStartAttempt(acl: AclProbe, releaseDigest: string) {
  return createCoreStartAttempt(async (signal) => {
    const context = await reviewedSystemContext(acl, releaseDigest, signal);
    if (!context) return null;
    const runner = createSystemLaunchctlRunner();
    return {
      uid: context.account.uid,
      executable: { dev: context.executable.dev, ino: context.executable.ino },
      files: context.files,
      nodeDigest: context.review.nodeDigest,
      helperDigest: context.review.peerOwnerDigest,
      peer: context.peer,
      job: async () => parseCoreStartJob(await runner(launchctlVector('print', 'core'))),
    };
  });
}
