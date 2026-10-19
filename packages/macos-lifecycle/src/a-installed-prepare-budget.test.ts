import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAInstalledReviewedSupervisorBootstrap, createASystemSupervisorBootstrapFromFixedSources } from './a-bootstrap.js';
import { configDigest, parseConfig } from './config.js';
import { root } from './contracts.js';
import type { RuntimeReview } from './runtime-review.js';
import type { bindReviewedCoreRuntime } from './adapters/runtime-authority.js';
import { runSupervisorEntry } from './supervisor-entry.js';

const ports = vi.hoisted(() => ({ session: vi.fn(), run: vi.fn(), ensure: vi.fn(), bind: vi.fn(), read: vi.fn() }));
vi.mock('./service-session.js', () => ({ createReviewedServiceSession: ports.session }));
vi.mock('./adapters/runtime-authority.js', () => ({
  bindReviewedCoreRuntime: ports.bind, bindReviewedCoreRuntimeAt: vi.fn(),
}));
vi.mock('./a-system-sources.js', () => ({ createSystemBootstrapSources: () => ({
  review: { read: ports.read }, records: { ensure: ports.ensure }, credentials: {}, acl: vi.fn(),
}) }));
const config = parseConfig({ schemaVersion: 1, mode: 'LAB_ONLY', runtimeUser: 'gram-agent',
  releaseId: 'lab-001', releaseDigest: 'a'.repeat(64), tunnel: { enabled: false } });
const review: RuntimeReview = { config, configDigest: configDigest(config), nodeDigest: 'b'.repeat(64),
  fileAclDigest: 'c'.repeat(64), peerOwnerDigest: 'd'.repeat(64) };
// Session construction is mocked; these tests exercise preparation authority,
// deadlines and cancellation, without acquiring runtime resources.
const runtime = { configuration: config } as Awaited<ReturnType<typeof bindReviewedCoreRuntime>>;
const invocation = { role: 'core' as const, configPath: `${root}/config/service.json` };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function bootstrap() { return createAInstalledReviewedSupervisorBootstrap({
  review: { read: ports.read }, bind: ports.bind, credentials: { async withValue() { throw new Error('UNUSED'); } },
}); }
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  ports.read.mockResolvedValue(review); ports.bind.mockResolvedValue(runtime); ports.ensure.mockResolvedValue(true);
  ports.run.mockImplementation(async (signal: AbortSignal) => { expect(signal.aborted).toBe(false); return 0; });
  ports.session.mockReturnValue({ run: ports.run });
});
afterEach(() => { vi.useRealTimers(); });

describe('installed preparation phase budgets', () => {
  it('runs a session after two independent 45-second reviews with fresh session cancellation', async () => {
    const phaseSignals: AbortSignal[] = [];
    ports.read.mockImplementation(async (signal: AbortSignal) => {
      phaseSignals.push(signal); await new Promise(done => setTimeout(done, 45_000)); return review;
    });
    ports.bind.mockImplementation(async (_review: RuntimeReview, signal: AbortSignal) => {
      phaseSignals.push(signal); await new Promise(done => setTimeout(done, 45_000)); return runtime;
    });
    const work = runSupervisorEntry(['--role', 'core', '--config', invocation.configPath], bootstrap(), new EventEmitter());
    await vi.advanceTimersByTimeAsync(90_000);
    expect(await work).toBe(0); expect(ports.run).toHaveBeenCalledTimes(1);
    expect(phaseSignals).toHaveLength(2); expect(phaseSignals[0]).not.toBe(phaseSignals[1]);
    expect(phaseSignals.every(signal => signal.aborted)).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['source', 'bind'] as const)('bounds a never-settling %s phase at 60 seconds', async phase => {
    const late = deferred<RuntimeReview & NonNullable<typeof runtime>>(); let phaseSignal!: AbortSignal;
    if (phase === 'source') ports.read.mockImplementation((signal: AbortSignal) => { phaseSignal = signal; return late.promise; });
    else ports.bind.mockImplementation((_review: RuntimeReview, signal: AbortSignal) => { phaseSignal = signal; return late.promise; });
    const work = bootstrap().prepare(invocation, new AbortController().signal);
    let settled = false; void work.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(59_999); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(await work).toBeNull(); expect(phaseSignal.aborted).toBe(true);
    late.resolve({ ...review, configuration: config } as RuntimeReview & NonNullable<typeof runtime>);
    await vi.advanceTimersByTimeAsync(0); expect(ports.session).not.toHaveBeenCalled();
    if (phase === 'source') expect(ports.bind).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['source', 'bind'] as const)('honors earlier parent cancellation during %s', async phase => {
    const controller = new AbortController();
    if (phase === 'source') ports.read.mockImplementation(() => new Promise(() => {}));
    else ports.bind.mockImplementation(() => new Promise(() => {}));
    const work = bootstrap().prepare(invocation, controller.signal);
    await vi.advanceTimersByTimeAsync(10); controller.abort();
    expect(await work).toBeNull(); expect(ports.session).not.toHaveBeenCalled();
    if (phase === 'source') expect(ports.bind).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('never dispatches binding after an already-dispatched create-only provision finishes late', async () => {
    const late = deferred<boolean>(); let provisionSignal!: AbortSignal;
    ports.ensure.mockImplementation((_review: RuntimeReview, signal: AbortSignal) => { provisionSignal = signal; return late.promise; });
    const work = createASystemSupervisorBootstrapFromFixedSources().prepare(invocation, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(60_000); expect(await work).toBeNull(); expect(provisionSignal.aborted).toBe(true);
    // Completion of an in-flight create-only write is not rollback. It cannot
    // authorize a new binder/session after cancellation.
    late.resolve(true); await vi.advanceTimersByTimeAsync(0);
    expect(ports.bind).not.toHaveBeenCalled(); expect(ports.session).not.toHaveBeenCalled();
  });
});
