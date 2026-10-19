import { decodeExecution, encodeExecution, type ExecutionLeaseStore } from './execution-lease.js';
import {
  coreStartIdentity,
  decodeCoreRegistration,
  encodeCoreRegistration,
  matchesCoreExecution,
  type CoreRegistrationStore,
} from './core-registration.js';
import { shaBytes } from './adapters/install-files.js';
import type { NativePeerProofPort, NativeProcessIdentity } from './adapters/owned-process.js';
import type { ReleaseFiles } from './adapters/trusted-files.js';
import type { Role } from './contracts.js';
import type { LifecycleStore } from './lifecycle-store.js';
import { readProof } from './proof-read.js';
import { RELEASE_REVIEW_TIMEOUT_MS } from './release-review-budget.js';

/** Native composition supplies only independently reviewed read capabilities.
 * This port is not serialized and is never selected through CLI/config/MCP.
 */
export interface CoreResumeProofContext {
  held: Buffer;
  registration: Buffer;
  revision: number;
  generation: string;
  identity: NativeProcessIdentity;
  peer: Pick<NativePeerProofPort, 'current'>;
  files: Pick<ReleaseFiles, 'hash'>;
  helperDigest: string;
  nodeDigest: string;
  execution: { read(role: Role, signal: AbortSignal): ReturnType<ExecutionLeaseStore['read']> };
  registrationStore: { read(signal: AbortSignal): ReturnType<CoreRegistrationStore['read']> };
  lifecycle: { read(role: Role, signal: AbortSignal): ReturnType<LifecycleStore['read']> };
  verify(signal: AbortSignal): Promise<void>;
}
export function createCoreResumeProof(load: (signal: AbortSignal) => Promise<CoreResumeProofContext | null>) {
  let captured: (CoreResumeProofContext & { pin: string }) | null = null;
  async function current(pin: string, expected: 'OWNED' | 'FOREIGN', parent?: AbortSignal): Promise<boolean> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), RELEASE_REVIEW_TIMEOUT_MS);
    const signal = parent ? AbortSignal.any([parent, deadline.signal]) : deadline.signal;
    try {
      if (signal.aborted) return false;
      const c = captured;
      if (!c || pin !== c.pin) return false;
      if (
        (await readProof(signal, () => c.files.hash('bin/peer-owner', 256 * 1024 * 1024))) !== c.helperDigest ||
        signal.aborted
      )
        return false;
      if (
        (await readProof(signal, () => c.files.hash('bin/node', 256 * 1024 * 1024))) !== c.nodeDigest ||
        signal.aborted
      )
        return false;
      if ((await readProof(signal, () => c.peer.current(c.identity, signal))) !== expected || signal.aborted)
        return false;
      await readProof(signal, () => c.verify(signal));
      const execution = await readProof(signal, () => c.execution.read('core', signal));
      const registration = await readProof(signal, () => c.registrationStore.read(signal));
      if (signal.aborted || registration === null || !encodeCoreRegistration(registration).equals(c.registration))
        return false;
      if (expected === 'OWNED') {
        if (!encodeExecution(execution).equals(c.held) || !matchesCoreExecution(registration, execution)) return false;
      } else {
        if (execution.state !== 'FREE' || execution.revision !== c.revision + 1) return false;
        const { history } = await readProof(signal, () => c.lifecycle.read('core', signal));
        if (
          history.blocked ||
          history.activeAttempt !== null ||
          history.exitsMs.length !== 0 ||
          history.lastGeneration !== c.generation
        )
          return false;
      }
      await readProof(signal, () => c.verify(signal));
      if (signal.aborted) return false;
      const verdict = await readProof(signal, () => c.peer.current(c.identity, signal));
      return !signal.aborted && verdict === expected;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      deadline.abort();
    }
  }
  return Object.freeze({
    async capture(): Promise<string | null> {
      captured = null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), RELEASE_REVIEW_TIMEOUT_MS);
      try {
        const context = await readProof(controller.signal, () => load(controller.signal));
        if (!context || controller.signal.aborted) return null;
        const held = decodeExecution(Buffer.from(context.held));
        const registration = decodeCoreRegistration(Buffer.from(context.registration));
        const start = coreStartIdentity(registration.child.startIdentity);
        if (
          held.state !== 'HELD' ||
          held.revision !== context.revision ||
          !matchesCoreExecution(registration, held) ||
          context.generation !== registration.child.generation ||
          context.identity.pid !== registration.child.pid ||
          context.identity.uid !== registration.child.uid ||
          context.identity.startSec !== start.sec ||
          context.identity.startUsec !== start.usec
        )
          return null;
        const pin = shaBytes(
          Buffer.concat([
            context.held,
            context.registration,
            Buffer.from(
              JSON.stringify({
                dev: context.identity.executable.dev.toString(),
                ino: context.identity.executable.ino.toString(),
              }),
            ),
          ]),
        );
        captured = {
          ...context,
          held: encodeExecution(held),
          registration: encodeCoreRegistration(registration),
          identity: Object.freeze({
            ...context.identity,
            executable: Object.freeze({ ...context.identity.executable }),
          }),
          pin,
        };
        if (!(await current(pin, 'OWNED', controller.signal)) || controller.signal.aborted) {
          captured = null;
          return null;
        }
        return pin;
      } catch {
        captured = null;
        return null;
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    },
    current,
  });
}
