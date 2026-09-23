import { afterEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { setImmediate as tick } from 'node:timers/promises';
import { attachChildOutput } from './child-output.js';
afterEach(() => vi.useRealTimers());
describe('discard-only owned child pipes', () => {
  it('drains both fragmented and oversized synthetic secret streams without returning bytes', async () => {
    const out = new PassThrough(); const err = new PassThrough(); const drain = attachChildOutput(out, err);
    out.write('SYNTH'); err.write('TOKEN=synthetic\nPATH=/private/secret'); out.write('ETIC_SECRET');
    out.end(Buffer.alloc(2 * 1024 * 1024, 120)); err.end('COOKIE=synthetic');
    expect(await drain.finish()).toBe('DRAINED'); expect(out.readableLength).toBe(0); expect(err.readableLength).toBe(0);
    expect(out.listenerCount('data')).toBe(0); expect(err.listenerCount('readable')).toBe(0);
  });
  it('has no startup deadline while a healthy child is running', async () => {
    vi.useFakeTimers(); const out = new PassThrough(); const drain = attachChildOutput(out, null);
    await vi.advanceTimersByTimeAsync(60000); expect(out.destroyed).toBe(false);
    const done = drain.finish(); await vi.advanceTimersByTimeAsync(19999); expect(out.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(await done).toBe('TIMED_OUT'); expect(out.destroyed).toBe(true);
  });
  it('uses one shutdown deadline for repeated finish calls', async () => {
    vi.useFakeTimers(); const out = new PassThrough(); const drain = attachChildOutput(out, null);
    const first = drain.finish(); await vi.advanceTimersByTimeAsync(10000); const second = drain.finish();
    expect(first).toBe(second); await vi.advanceTimersByTimeAsync(10000); expect(await first).toBe('TIMED_OUT');
  });
  it('cancels a drain without exposing the abort reason', async () => {
    const out = new PassThrough(); const err = new PassThrough(); const controller = new AbortController();
    const drain = attachChildOutput(out, err); const done = drain.finish(controller.signal);
    controller.abort(new Error('SYNTHETIC_SECRET')); expect(await done).toBe('ABORTED');
    await tick(); expect(out.destroyed).toBe(true); expect(err.destroyed).toBe(true);
    expect(out.listenerCount('error')).toBe(0); expect(err.listenerCount('close')).toBe(0);
  });
  it('handles an already-aborted drain and absent pipes', async () => {
    const controller = new AbortController(); controller.abort('SYNTHETIC_SECRET');
    const out = new PassThrough(); expect(await attachChildOutput(out, null).finish(controller.signal)).toBe('ABORTED');
    expect(await attachChildOutput(null, null).finish()).toBe('DRAINED'); await tick();
  });
  it('contains a stream error without propagating raw error text', async () => {
    const out = new PassThrough(); const err = new PassThrough(); const drain = attachChildOutput(out, err);
    out.destroy(new Error('SYNTHETIC_SECRET')); err.end(); expect(await drain.finish()).toBe('STREAM_ERROR');
    await tick(); expect(out.listenerCount('error')).toBe(0); expect(err.listenerCount('end')).toBe(0);
  });
  it('handles streams which already ended or closed', async () => {
    const out = new PassThrough(); out.resume(); out.end(); await tick();
    expect(await attachChildOutput(out, null).finish()).toBe('DRAINED');
    const err = new PassThrough(); err.destroy(); await tick();
    expect(await attachChildOutput(null, err).finish()).toBe('DRAINED');
  });
  it('rejects an object-mode or duplicate pipe without inspecting payloads', () => {
    const object = new PassThrough({ objectMode: true }); const binary = new PassThrough();
    expect(() => attachChildOutput(object, null)).toThrow(/^INVALID_OUTPUT_STREAM$/);
    expect(() => attachChildOutput(binary, binary)).toThrow(/^INVALID_OUTPUT_STREAM$/);
    object.destroy(); binary.destroy();
  });
});
