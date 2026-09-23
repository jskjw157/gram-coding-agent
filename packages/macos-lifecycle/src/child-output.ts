import type { Readable } from 'node:stream';
export type DrainResult = 'DRAINED' | 'TIMED_OUT' | 'ABORTED' | 'STREAM_ERROR';
export interface OutputDrain { finish(signal?: AbortSignal): Promise<DrainResult> }
export function attachChildOutput(stdout: Readable | null, stderr: Readable | null): OutputDrain {
  void stdout; void stderr; throw new Error('NOT_IMPLEMENTED');
}
