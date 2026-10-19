import type { NativePeerProofPort, ExecutableIdentity, NativeProcessIdentity } from './adapters/owned-process.js';
import type { ReleaseFiles } from './adapters/trusted-files.js';
import { shaBytes } from './adapters/install-files.js';
import { readProof } from './proof-read.js';
import { RELEASE_REVIEW_TIMEOUT_MS } from './release-review-budget.js';
export interface CoreStartAttemptContext {
  uid: number;
  executable: ExecutableIdentity;
  helperDigest: string;
  nodeDigest: string;
  files: Pick<ReleaseFiles, 'hash'>;
  peer: Pick<NativePeerProofPort, 'capture' | 'current'>;
  job(): Promise<{ state: 'present'; pid: number } | { state: 'absent' } | null>;
}
/** Read-only proof for the fixed launchd supervisor while Core has no health pin.
 * A job PID is merely an association; native UID/start-time/executable evidence
 * is always required. No signal is sent here and no arbitrary PID is accepted.
 */
export function createCoreStartAttempt(load: (signal: AbortSignal) => Promise<CoreStartAttemptContext | null>) {
  let captured: { context: CoreStartAttemptContext; identity: NativeProcessIdentity; pin: string } | null = null;
  async function current(pin: string, expected: 'OWNED' | 'FOREIGN', parent?: AbortSignal): Promise<boolean> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), RELEASE_REVIEW_TIMEOUT_MS);
    const signal = parent ? AbortSignal.any([parent, deadline.signal]) : deadline.signal;
    try {
      const c = captured;
      if (!c || c.pin !== pin || signal.aborted) return false;
      const matches = async () => {
        const job = await readProof(signal, () => c.context.job());
        return (
          !signal.aborted &&
          job !== null &&
          (expected === 'OWNED' ? job.state === 'present' && job.pid === c.identity.pid : job.state === 'absent')
        );
      };
      if (
        !(await matches()) ||
        (await readProof(signal, () => c.context.files.hash('bin/node', 256 * 1024 * 1024))) !== c.context.nodeDigest ||
        signal.aborted ||
        (await readProof(signal, () => c.context.files.hash('bin/peer-owner', 256 * 1024 * 1024))) !==
          c.context.helperDigest ||
        signal.aborted
      )
        return false;
      if (
        (await readProof(signal, () => c.context.peer.current(c.identity, signal))) !== expected ||
        signal.aborted ||
        !(await matches())
      )
        return false;
      const verdict = await readProof(signal, () => c.context.peer.current(c.identity, signal));
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
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), RELEASE_REVIEW_TIMEOUT_MS);
      try {
        const context = await readProof(deadline.signal, () => load(deadline.signal));
        if (!context || deadline.signal.aborted) return null;
        const job = await readProof(deadline.signal, () => context.job());
        if (
          !job ||
          job.state !== 'present' ||
          !Number.isSafeInteger(job.pid) ||
          job.pid < 1 ||
          job.pid > 0x7fff_ffff ||
          !Number.isSafeInteger(context.uid) ||
          context.uid < 1 ||
          deadline.signal.aborted
        )
          return null;
        const request = { pid: job.pid, uid: context.uid, executable: Object.freeze({ ...context.executable }) };
        const start = await readProof(deadline.signal, () => context.peer.capture(request, deadline.signal));
        if (!start || deadline.signal.aborted) return null;
        const identity = Object.freeze({ ...request, startSec: start.sec, startUsec: start.usec });
        const pin = shaBytes(
          Buffer.from(
            JSON.stringify({
              pid: identity.pid,
              uid: identity.uid,
              sec: start.sec,
              usec: start.usec,
              dev: identity.executable.dev.toString(),
              ino: identity.executable.ino.toString(),
            }),
          ),
        );
        captured = { context, identity, pin };
        if (!(await current(pin, 'OWNED', deadline.signal)) || deadline.signal.aborted) {
          captured = null;
          return null;
        }
        return pin;
      } catch {
        captured = null;
        return null;
      } finally {
        clearTimeout(timer);
        deadline.abort();
      }
    },
    current,
  });
}
