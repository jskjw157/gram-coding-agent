import type { InstallResult, LockSession } from './installation-transaction/contracts.js';

/** Internal, fixed Core-only recovery capabilities. A native review must bind
 * every installed/staged byte, stopped registry, pristine runtime record and
 * key metadata. Neither a label nor an unauthenticated health response is proof.
 * No generic path/command/credential input and no automatic partial replay.
 */
export type ResumeTransition = 'confirmed' | 'refused' | 'uncertain';
export interface PublishedResumeResult extends InstallResult {
  uncertain?: true;
  compensationUnknown?: true;
  lockUnknown?: true;
}
export interface FreshPublishedResumePorts {
  authorizeLocalAdmin(): Promise<boolean>;
  lock(): Promise<LockSession>;
  review(): Promise<{ transactionDigest: string } | null>;
  startCore(): Promise<InstallResult>;
  ownedCore(): Promise<string | null>;
  markStarted(transactionDigest: string): Promise<ResumeTransition>;
  parkCore(ownedPin: string): Promise<boolean>;
  commit(transactionDigest: string, ownedPin: string): Promise<ResumeTransition>;
  compensateCore(): Promise<boolean>;
}

export async function resumeFreshPublished(
  expectedTransactionDigest: string,
  ports: FreshPublishedResumePorts,
): Promise<PublishedResumeResult> {
  const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (!hex(expectedTransactionDigest)) return { ok: false, code: 'CONFIG_CHANGED' };
  try {
    if ((await ports.authorizeLocalAdmin()) !== true) return { ok: false, code: 'NOT_AUTHORIZED' };
  } catch {
    return { ok: false, code: 'NOT_AUTHORIZED' };
  }
  let lock: LockSession;
  try {
    lock = await ports.lock();
  } catch {
    return { ok: false, code: 'PARTIAL_INSTALL' };
  }
  if (lock.acquired !== true) return { ok: false, code: 'BUSY' };
  let stage: 'PUBLISHED' | 'STARTED' | 'COMMITTED' = 'PUBLISHED';
  let requestedStart = false;
  let result: PublishedResumeResult;
  const run = async (): Promise<PublishedResumeResult> => {
    const review = await ports.review();
    if (review === null || review.transactionDigest !== expectedTransactionDigest)
      return { ok: false, code: 'CONFIG_CHANGED' };
    requestedStart = true;
    const started = await ports.startCore();
    if (started.ok !== true) return { ok: false, code: started.code, stage };
    const pin = await ports.ownedCore();
    if (!hex(pin)) return { ok: false, code: 'HEALTH_UNKNOWN', stage };
    let startedWrite: ResumeTransition;
    try {
      startedWrite = await ports.markStarted(expectedTransactionDigest);
    } catch {
      startedWrite = 'uncertain';
    }
    if (startedWrite !== 'confirmed')
      return startedWrite === 'refused'
        ? { ok: false, code: 'PARTIAL_INSTALL', stage }
        : { ok: false, code: 'PARTIAL_INSTALL', uncertain: true };
    stage = 'STARTED';
    if ((await ports.parkCore(pin)) !== true) return { ok: false, code: 'PARTIAL_INSTALL', stage };
    let committedWrite: ResumeTransition;
    try {
      committedWrite = await ports.commit(expectedTransactionDigest, pin);
    } catch {
      committedWrite = 'uncertain';
    }
    if (committedWrite !== 'confirmed')
      return committedWrite === 'refused'
        ? { ok: false, code: 'PARTIAL_INSTALL', stage }
        : { ok: false, code: 'PARTIAL_INSTALL', uncertain: true };
    stage = 'COMMITTED';
    return { ok: true, code: 'OK', stage };
  };
  try {
    result = await run();
  } catch {
    result = { ok: false, code: 'PARTIAL_INSTALL', stage };
  }
  if (!result.ok && requestedStart) {
    let compensated = false;
    try {
      compensated = (await ports.compensateCore()) === true;
    } catch {
      /* preserve unknown scope; never retry a blind stop */
    }
    if (!compensated) result = { ...result, code: 'PARTIAL_INSTALL', compensationUnknown: true };
  }
  try {
    await lock.release();
  } catch {
    return { ...result, ok: false, code: 'PARTIAL_INSTALL', lockUnknown: true };
  }
  return result;
}
