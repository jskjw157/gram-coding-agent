import { Readable } from 'node:stream';
export type DrainResult = 'DRAINED' | 'TIMED_OUT' | 'ABORTED' | 'STREAM_ERROR';
export interface OutputDrain { finish(signal?: AbortSignal): Promise<DrainResult> }

/** Take exclusive ownership of the direct child's byte pipes at spawn. Resume
 * drops bytes without concatenating/decoding/retaining or logging them. Start
 * the 20s drain deadline only on shutdown via finish(); this does not signal or
 * kill a process. The supervisor separately handles the owned child deadline.
 */
export function attachChildOutput(stdout: Readable | null, stderr: Readable | null): OutputDrain {
  const streams = [stdout, stderr].filter((s): s is Readable => s !== null);
  if (new Set(streams).size !== streams.length || streams.some(s => !(s instanceof Readable) || s.readableObjectMode)) {
    throw new Error('INVALID_OUTPUT_STREAM');
  }
  const pending = new Set(streams); let failed = false; let result: DrainResult | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined; let removeAbort = () => {};
  let resolveDone: (value: DrainResult) => void = () => {};
  const done = new Promise<DrainResult>(resolve => { resolveDone = resolve; });
  const settle = (value: DrainResult) => {
    if (result !== null) return;
    result = value; clearTimeout(timer); removeAbort(); resolveDone(value);
  };
  const completed = () => { if (pending.size === 0) settle(failed ? 'STREAM_ERROR' : 'DRAINED'); };
  for (const stream of streams) {
    if (stream.errored !== null) failed = true;
    if (stream.closed) { pending.delete(stream); continue; }
    const end = () => { pending.delete(stream); completed(); };
    const error = () => { failed = true; stream.destroy(); };
    const close = () => {
      pending.delete(stream); stream.off('end', end); stream.off('error', error); stream.off('close', close); completed();
    };
    // Retain an error guard until close: destroy can emit a later _destroy error.
    stream.on('error', error); stream.once('end', end); stream.once('close', close);
    if (stream.readableEnded) pending.delete(stream);
    else stream.resume();
  }
  completed();
  let finishing = false;
  const stopPipes = (value: DrainResult) => {
    settle(value);
    for (const stream of streams) if (!stream.destroyed) stream.destroy();
  };
  return Object.freeze({
    finish(signal?: AbortSignal): Promise<DrainResult> {
      if (!finishing && result === null) {
        finishing = true;
        if (signal?.aborted) stopPipes('ABORTED');
        else {
          const abort = () => stopPipes('ABORTED');
          if (signal) { signal.addEventListener('abort', abort, { once: true }); removeAbort = () => signal.removeEventListener('abort', abort); }
          timer = setTimeout(() => stopPipes('TIMED_OUT'), 20000);
        }
      }
      return done;
    },
  });
}
