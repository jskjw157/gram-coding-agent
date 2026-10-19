import { abortable } from './health-probe.js';
import { RELEASE_REVIEW_TIMEOUT_MS } from './release-review-budget.js';

/** Independent installed-source or provision/bind preparation phase. An earlier
 * caller cancellation wins. Late results cannot authorize subsequent work.
 * Abort is cooperative: an already-dispatched create-only record write may
 * finish after return; this makes no rollback or writer-quiescence claim.
 * Returned runtime capabilities must use fresh per-operation signals.
 */
export async function runPreparePhase<T>(parent: AbortSignal,
  use: (signal: AbortSignal) => Promise<T | null>): Promise<T | null> {
  if (parent.aborted) return null;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), RELEASE_REVIEW_TIMEOUT_MS);
  const signal = AbortSignal.any([parent, deadline.signal]);
  try {
    const result = await abortable(Promise.resolve(use(signal)), signal);
    return signal.aborted ? null : result;
  } catch { return null; }
  finally { clearTimeout(timer); deadline.abort(); }
}
