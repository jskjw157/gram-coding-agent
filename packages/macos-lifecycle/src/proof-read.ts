import { abortable } from './health-probe.js';

/** Bound only read-only proof observations. An ignored abort may leave the
 * underlying read unwinding, but cannot authorize a late action or dispatch
 * another read. Do not use this boundary for writes or service operations.
 */
export async function readProof<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  if (signal.aborted) throw new Error('HEALTH_UNKNOWN');
  const value = await abortable(operation(), signal);
  if (signal.aborted) throw new Error('HEALTH_UNKNOWN');
  return value;
}
