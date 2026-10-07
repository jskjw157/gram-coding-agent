import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { root } from './contracts.js';
import { parseSupervisorInvocation, runSupervisorEntry, type SupervisorBootstrap } from './supervisor-entry.js';
const configPath = `${root}/config/service.json`;
const args = ['--role', 'core', '--config', configPath];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
afterEach(() => vi.useRealTimers());
describe('fixed supervisor invocation and cancellation', () => {
  it.each(['core', 'tunnel'])('parses only fixed %s role and installed configuration', role => {
    expect(parseSupervisorInvocation(['--config', configPath, '--role', role])).toEqual({ role, configPath });
    expect(Object.isFrozen(parseSupervisorInvocation(['--role', role, '--config', configPath]))).toBe(true);
  });
  it.each([
    [], ['--role', 'root', '--config', configPath], ['--role', 'core'],
    ['--role', 'core', '--config', '/tmp/service.json'], ['--config', configPath, '--config', configPath],
    ['--role', 'core', '--config', configPath, '--force'], ['core', '--role', 'core', '--config', configPath],
    ['--role', 'core', '--config', configPath + '\n'], ['--role=core', '--config', configPath],
  ].map(argv => ({ argv })))('rejects invalid argv before bootstrap or signal hooks: $argv', async ({ argv }) => {
    let prepared = 0; const events = new EventEmitter();
    expect(await runSupervisorEntry(argv, { async prepare() { prepared++; return null; } }, events)).toBe(64);
    expect(prepared).toBe(0); expect(events.eventNames()).toEqual([]);
  });
  it('does not invoke accessor argv elements', async () => {
    let reads = 0; const argv = [...args]; Object.defineProperty(argv, '1', { enumerable: true, get() { reads++; return 'core'; } });
    expect(await runSupervisorEntry(argv)).toBe(64); expect(reads).toBe(0);
  });
  it('requires a local bootstrap capability, not a fabricated successful CLI', async () => {
    expect(await runSupervisorEntry(args)).toBe(78);
  });
  it('installs both signals before bootstrap and removes only its own listeners', async () => {
    const events = new EventEmitter(); const other = () => {}; events.on('SIGTERM', other);
    let runs = 0;
    const result = await runSupervisorEntry(args, { async prepare(request, signal) {
      expect(request).toEqual({ role: 'core', configPath }); expect(signal.aborted).toBe(false);
      expect(events.listenerCount('SIGTERM')).toBe(2); expect(events.listenerCount('SIGINT')).toBe(1);
      return { async run() { runs++; return 0; } };
    } }, events);
    expect(result).toBe(0); expect(runs).toBe(1);
    expect(events.listeners('SIGTERM')).toEqual([other]); expect(events.listenerCount('SIGINT')).toBe(0);
  });
  it('does not start a late bootstrap result after cancellation', async () => {
    const events = new EventEmitter(); const ready = deferred<Awaited<ReturnType<SupervisorBootstrap['prepare']>>>();
    const entered = deferred<undefined>(); let runs = 0;
    const work = runSupervisorEntry(args, { async prepare() { entered.resolve(undefined); return ready.promise; } }, events);
    await Promise.race([entered.promise, work.then(() => { throw new Error('BOOTSTRAP_NOT_ENTERED'); })]);
    events.emit('SIGTERM'); expect(await work).toBe(0);
    ready.resolve({ async run() { runs++; return 0; } }); await Promise.resolve(); await Promise.resolve();
    expect(runs).toBe(0); expect(events.eventNames()).toEqual([]);
  });
  it('awaits the actual session shutdown instead of racing cancellation to success', async () => {
    const events = new EventEmitter(); const entered = deferred<AbortSignal>(); const stopped = deferred<number>();
    let settled = false;
    const work = runSupervisorEntry(args, { async prepare() { return { async run(signal) { entered.resolve(signal); return stopped.promise; } }; } }, events);
    void work.then(() => { settled = true; }, () => { settled = true; });
    const signal = await Promise.race([entered.promise, work.then(() => { throw new Error('SESSION_NOT_ENTERED'); })]);
    events.emit('SIGINT'); await Promise.resolve(); expect(signal.aborted).toBe(true); expect(settled).toBe(false);
    stopped.resolve(1); expect(await work).toBe(1); expect(events.eventNames()).toEqual([]);
  });
  it('runs a valid session after a 21-second sealed-release preparation', async () => {
    vi.useFakeTimers(); const events = new EventEmitter(); let runs = 0;
    const work = runSupervisorEntry(args, { async prepare() {
      await new Promise<void>(resolve => setTimeout(resolve, 21000));
      return { async run() { runs++; return 0; } };
    } }, events);
    await vi.advanceTimersByTimeAsync(21000);
    expect(await work).toBe(0); expect(runs).toBe(1); expect(events.eventNames()).toEqual([]);
  });
  it('bounds bootstrap waiting and never runs a timed-out late session', async () => {
    vi.useFakeTimers(); const events = new EventEmitter(); const ready = deferred<Awaited<ReturnType<SupervisorBootstrap['prepare']>>>(); let runs = 0;
    const work = runSupervisorEntry(args, { async prepare() { return ready.promise; } }, events);
    const observed = work.then(value => value as unknown, (error: unknown) => error);
    let settled = false; void observed.then(() => { settled = true; });
    try {
      await vi.advanceTimersByTimeAsync(59999); expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1); expect(await observed).toBe(78);
    } finally { ready.resolve({ async run() { runs++; return 0; } }); await observed; }
    await Promise.resolve(); await Promise.resolve();
    expect(runs).toBe(0); expect(events.eventNames()).toEqual([]);
  });
  it.each([2, -1, NaN, '0'])('does not accept an invalid runtime exit result: %s', async value => {
    expect(await runSupervisorEntry(args, { async prepare() { return { async run() { return value as number; } }; } }, new EventEmitter())).toBe(70);
  });
  it('maps bootstrap and runtime exceptions without exporting provider text', async () => {
    const events = new EventEmitter();
    expect(await runSupervisorEntry(args, { async prepare() { throw new Error('SYNTHETIC_PRIVATE_BOOT'); } }, events)).toBe(70);
    expect(await runSupervisorEntry(args, { async prepare() { return { async run() { throw new Error('SYNTHETIC_PRIVATE_RUN'); } }; } }, events)).toBe(70);
    expect(events.eventNames()).toEqual([]);
  });
});
