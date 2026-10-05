import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { root, type Role } from './contracts.js';
import { inspectMacAccount } from './adapters/macos-inspection.js';
import { inspectRuntimeDirectories } from './adapters/runtime-directories.js';
import { createRuntimeStores } from './adapters/runtime-stores.js';
import { createExecutionFilesAt } from './adapters/execution-files.js';
import { createCoreProcessFilesAt } from './adapters/core-process-files.js';
import { createTunnelProcessFilesAt } from './adapters/tunnel-process-files.js';
import { createTrustedFiles, type AclProbe } from './adapters/trusted-files.js';
import { createNativePeerProof } from './adapters/owned-process.js';
import { ExecutionLeaseStore, encodeExecution } from './execution-lease.js';
import {
  CoreRegistrationStore,
  coreStartIdentity,
  encodeCoreRegistration,
  matchesCoreExecution,
} from './core-registration.js';
import {
  TunnelRegistrationStore,
  encodeTunnelRegistration,
  matchesTunnelExecution,
} from './tunnel-registration.js';
import { inspectRelease } from './release-inspection.js';
import { createInstalledRuntimeReviewSource } from './a-system-sources.js';
import type { RecordFiles } from './telemetry-store.js';

export interface InstalledHealthObserver {
  healthy(role: Role, signal: AbortSignal): Promise<boolean>;
}

function sameExecutable(
  stat: Awaited<ReturnType<typeof lstat>>,
  ownerUid: number,
): boolean {
  return stat.isFile()
    && stat.uid === ownerUid
    && stat.nlink === 1
    && (Number(stat.mode) & 0o6022) === 0
    && (Number(stat.mode) & 0o111) !== 0;
}

export function createInstalledHealthObserver(acl: AclProbe): InstalledHealthObserver {
  return Object.freeze({
    async healthy(role: Role, signal: AbortSignal): Promise<boolean> {
      try {
        if ((role !== 'core' && role !== 'tunnel') || signal.aborted
          || process.platform !== 'darwin' || process.arch !== 'arm64') return false;

        const account = await inspectMacAccount();
        if (account === null || account.admin !== false || signal.aborted) return false;

        const sourceLayout = {
          anchor: '/',
          relative: root.slice(1),
          ownerUid: 0,
          runtimeUid: account.uid,
          runtimeGid: account.gid,
          acl,
        };
        const review = await createInstalledRuntimeReviewSource(sourceLayout).read(signal);
        if (review === null || signal.aborted) return false;
        if (role === 'tunnel' && !review.config.tunnel.enabled) return false;

        const directories = await inspectRuntimeDirectories(
          { anchor: '/', relative: root.slice(1), ownerUid: 0 },
          account.uid,
          acl,
          signal,
        );
        const verify = directories.verify.bind(directories);
        const guard = (raw: RecordFiles): RecordFiles => Object.freeze<RecordFiles>({
          async read(candidate) {
            await verify();
            const value = await raw.read(candidate);
            await verify();
            return value;
          },
          async compareAndSwap(candidate, expected, slot, bytes) {
            await verify();
            await raw.compareAndSwap(candidate, expected, slot, bytes);
            await verify();
          },
        });

        const execution = new ExecutionLeaseStore(
          guard(createExecutionFilesAt(directories.runPolicy)),
        );
        const coreRegistration = new CoreRegistrationStore(
          guard(createCoreProcessFilesAt(directories.runPolicy)),
          execution,
        );
        const tunnelRegistration = review.config.tunnel.enabled
          ? new TunnelRegistrationStore(
            guard(createTunnelProcessFilesAt(directories.runPolicy)),
            execution,
          )
          : null;
        const stores = createRuntimeStores(directories);

        const held = await execution.read(role);
        if (held.state !== 'HELD'
          || held.releaseDigest !== review.config.releaseDigest
          || held.configDigest !== review.configDigest) return false;

        const registration = role === 'core'
          ? await coreRegistration.read()
          : await tunnelRegistration?.read() ?? null;
        if (registration === null) return false;
        const matched = role === 'core'
          ? registration.role === 'core' && matchesCoreExecution(registration, held)
          : registration.role === 'tunnel' && matchesTunnelExecution(registration, held);
        if (!matched) return false;

        const registrationBytes = role === 'core'
          ? encodeCoreRegistration(registration)
          : encodeTunnelRegistration(registration);
        const executionBytes = encodeExecution(held);

        const releasePrefix = `${root.slice(1)}/releases/${review.config.releaseId}`;
        const releaseFiles = createTrustedFiles('/', 0, acl, releasePrefix);
        await inspectRelease(review.config, review.config.releaseDigest, releaseFiles);
        if (signal.aborted) return false;

        const helperPath = join(root, 'releases', review.config.releaseId, 'bin', 'peer-owner');
        const helperStat = await lstat(helperPath);
        if (!sameExecutable(helperStat, 0)
          || await releaseFiles.hash('bin/peer-owner', 256 * 1024 * 1024) !== review.peerOwnerDigest) {
          return false;
        }

        const executableRelative = role === 'core' ? 'bin/node' : 'bin/tunnel-client';
        const executablePath = join(root, 'releases', review.config.releaseId, executableRelative);
        const executableStat = await lstat(executablePath);
        if (!sameExecutable(executableStat, 0)) return false;
        if (role === 'core'
          && await releaseFiles.hash('bin/node', 256 * 1024 * 1024) !== review.nodeDigest) return false;

        const start = coreStartIdentity(registration.child.startIdentity);
        const proof = createNativePeerProof(helperPath);
        const identity = Object.freeze({
          pid: registration.child.pid,
          uid: registration.child.uid,
          startSec: start.sec,
          startUsec: start.usec,
          executable: Object.freeze({ dev: BigInt(executableStat.dev), ino: BigInt(executableStat.ino) }),
        });
        if (await proof.current(identity, signal) !== 'OWNED' || signal.aborted) return false;

        const status = await stores.telemetry.readStatus(
          role,
          {
            role,
            generation: registration.child.generation,
            releaseDigest: registration.child.releaseDigest,
          },
          Date.now(),
        );
        if (status === null || status.code !== 'OK'
          || (role === 'core' ? status.state !== 'LOCAL_CORE_HEALTHY' : status.state !== 'TRANSPORT_READY')) {
          return false;
        }

        if (await proof.current(identity, signal) !== 'OWNED' || signal.aborted) return false;

        const afterExecution = await execution.read(role);
        if (!encodeExecution(afterExecution).equals(executionBytes)) return false;
        const afterRegistration = role === 'core'
          ? await coreRegistration.read()
          : await tunnelRegistration?.read() ?? null;
        if (afterRegistration === null) return false;
        const afterRegistrationBytes = role === 'core'
          ? afterRegistration.role === 'core' ? encodeCoreRegistration(afterRegistration) : null
          : afterRegistration.role === 'tunnel' ? encodeTunnelRegistration(afterRegistration) : null;
        return afterRegistrationBytes !== null
          && afterRegistrationBytes.equals(registrationBytes)
          && !signal.aborted;
      } catch {
        return false;
      }
    },
  });
}
