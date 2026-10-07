import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { labels, type Role } from '../contracts.js';
import type { InstallResult } from '../installation-transaction/contracts.js';
import {
  createLaunchctlServices,
  launchctlVector,
  type LaunchctlAction,
  type LaunchctlObservation,
  type LaunchctlRunner,
} from './launchctl.js';

const completed: LaunchctlObservation = { code: 0, stdout: '', stderr: '' };
const present = (role: Role): LaunchctlObservation => ({
  code: 0, stdout: `system/${labels[role]} = {\n}\n`, stderr: '',
});
const absent = (role: Role): LaunchctlObservation => ({
  code: 113, stdout: '', stderr: `Could not find service "${labels[role]}" in domain for system\n`,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}
function delayed<T>(value: T, ms: number): Promise<T> {
  return new Promise(resolve => setTimeout(() => resolve(value), ms));
}
function harness(reply: (action: LaunchctlAction, call: number) => ReturnType<LaunchctlRunner> | LaunchctlObservation) {
  const seen: Array<{ argv: readonly string[]; atMs: number }> = [];
  const services = createLaunchctlServices(async argv => {
    seen.push({ argv, atMs: performance.now() });
    return reply(argv[1] as LaunchctlAction, seen.length);
  });
  return { seen, services };
}
function stopping(services: ReturnType<typeof createLaunchctlServices>, role: Role = 'core') {
  let result: InstallResult | undefined;
  const work = services.stop(role).then(value => { result = value; });
  return { work, result: () => result };
}
const actions = (seen: ReturnType<typeof harness>['seen']) => seen.map(call => call.argv[1]);
function expectOnlyFixedStop(seen: ReturnType<typeof harness>['seen'], role: Role) {
  expect(seen.slice(0, 3).map(call => call.argv)).toEqual(
    ['print', 'disable', 'bootout'].map(action => launchctlVector(action as LaunchctlAction, role)),
  );
  expect(seen.slice(3).map(call => call.argv)).toEqual(
    seen.slice(3).map(() => launchctlVector('print', role)),
  );
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('launchctl waits for asynchronous removal after a clean bootout', () => {
  it.each(['core', 'tunnel'] as const)('waits through a two-second %s drain with read-only 200 ms observations', async role => {
    const { seen, services } = harness(action => action === 'print'
      ? performance.now() < 2000 ? present(role) : absent(role) : completed);
    const pending = stopping(services, role);
    await vi.advanceTimersByTimeAsync(1999);
    expect(pending.result()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1); await pending.work;
    expect(pending.result()).toEqual({ ok: true, code: 'OK' });
    expectOnlyFixedStop(seen, role);
    expect(seen.slice(3).map(call => call.atMs)).toEqual(Array.from({ length: 11 }, (_, index) => index * 200));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails a persistently present job at the shared deadline and dispatches no later command', async () => {
    const { seen, services } = harness(action => action === 'print' ? present('core') : completed);
    const pending = stopping(services);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(pending.result()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1); await pending.work;
    expect(pending.result()).toEqual({ ok: false, code: 'PARTIAL_INSTALL' });
    expectOnlyFixedStop(seen, 'core');
    expect(seen.slice(3).map(call => call.atMs)).toEqual(Array.from({ length: 150 }, (_, index) => index * 200));
    expect(vi.getTimerCount()).toBe(0);
    const count = seen.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(seen).toHaveLength(count);
  });

  it('charges bootout and the final partial backoff to one thirty-second budget', async () => {
    const { seen, services } = harness(action => action === 'print' ? present('core')
      : action === 'bootout' ? delayed(completed, 28_100) : completed);
    const pending = stopping(services);
    await vi.advanceTimersByTimeAsync(28_099);
    expect(actions(seen)).toEqual(['print', 'disable', 'bootout']);
    expect(pending.result()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1900);
    expect(pending.result()).toBeUndefined();
    expect(seen.slice(3).map(call => call.atMs)).toEqual(Array.from({ length: 10 }, (_, index) => 28_100 + index * 200));
    await vi.advanceTimersByTimeAsync(1); await pending.work;
    expect(pending.result()).toEqual({ ok: false, code: 'PARTIAL_INSTALL' });
    expectOnlyFixedStop(seen, 'core');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts the termination budget after successful disable, leaving initial command behavior intact', async () => {
    const { seen, services } = harness((action, call) => {
      if (action === 'print') return call === 1 ? delayed(present('core'), 4000) : absent('core');
      return delayed(completed, action === 'disable' ? 4000 : 29_000);
    });
    const pending = stopping(services);
    await vi.advanceTimersByTimeAsync(36_999);
    expect(pending.result()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1); await pending.work;
    expect(pending.result()).toEqual({ ok: true, code: 'OK' });
    expect(seen.map(call => call.atMs)).toEqual([0, 4000, 8000, 37_000]);
    expectOnlyFixedStop(seen, 'core');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('launchctl termination deadline bounds noncooperative commands', () => {
  it('bounds a pending bootout and never dispatches print when it eventually acknowledges', async () => {
    const bootout = deferred<LaunchctlObservation>();
    const { seen, services } = harness(action => action === 'print' ? present('core')
      : action === 'bootout' ? bootout.promise : completed);
    const pending = stopping(services);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(pending.result()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(pending.result()).toEqual({ ok: false, code: 'PARTIAL_INSTALL' });
    await pending.work;
    expect(vi.getTimerCount()).toBe(0);
    bootout.resolve(completed);
    await vi.advanceTimersByTimeAsync(1000);
    expect(actions(seen)).toEqual(['print', 'disable', 'bootout']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['absence', 'rejection'] as const)('bounds a pending print and ignores its late %s', async settlement => {
    const print = deferred<LaunchctlObservation>();
    const { seen, services } = harness((action, call) => action === 'print'
      ? call === 1 ? present('core') : print.promise : completed);
    const pending = stopping(services);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(pending.result()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(pending.result()).toEqual({ ok: false, code: 'PARTIAL_INSTALL' });
    await pending.work;
    expect(vi.getTimerCount()).toBe(0);
    if (settlement === 'absence') print.resolve(absent('core'));
    else print.reject(new Error('SYNTHETIC_PRIVATE_LATE_FAILURE'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(pending.result()).toEqual({ ok: false, code: 'PARTIAL_INSTALL' });
    expect(actions(seen)).toEqual(['print', 'disable', 'bootout', 'print']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['bootout', 'print'] as const)('rejects %s completion exactly at the deadline even when its callback runs first', async stage => {
    const response = deferred<LaunchctlObservation>();
    // Queue this callback before stop can arm its deadline: the observation
    // must still be too late even if its promise wins the timer callback race.
    setTimeout(() => response.resolve(stage === 'bootout' ? completed : absent('core')), 30_000);
    const { seen, services } = harness((action, call) => {
      if (call === 1) return present('core');
      if (action === stage) return response.promise;
      return action === 'print' ? absent('core') : completed;
    });
    const pending = stopping(services);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(pending.result()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1); await pending.work;
    expect(pending.result()).toEqual({ ok: false, code: 'PARTIAL_INSTALL' });
    expect(actions(seen)).toEqual(stage === 'bootout'
      ? ['print', 'disable', 'bootout'] : ['print', 'disable', 'bootout', 'print']);
    expect(vi.getTimerCount()).toBe(0);
    const count = seen.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toHaveLength(count);
  });

  it('charges a pending print to the remaining budget after bootout', async () => {
    const print = deferred<LaunchctlObservation>();
    const { seen, services } = harness((action, call) => action === 'print'
      ? call === 1 ? present('core') : print.promise
      : action === 'bootout' ? delayed(completed, 29_000) : completed);
    const pending = stopping(services);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(pending.result()).toBeUndefined();
    expect(seen.map(call => call.atMs)).toEqual([0, 0, 0, 29_000]);
    await vi.advanceTimersByTimeAsync(1);
    expect(pending.result()).toEqual({ ok: false, code: 'PARTIAL_INSTALL' });
    await pending.work;
    expect(vi.getTimerCount()).toBe(0);
    print.resolve(absent('core'));
    await vi.advanceTimersByTimeAsync(1);
    expect(actions(seen)).toEqual(['print', 'disable', 'bootout', 'print']);
  });
});

describe('launchctl retries only clean acknowledgements followed by valid presence', () => {
  const errors = [
    { name: 'permission', observation: { code: 1, stdout: '', stderr: 'Operation not permitted SYNTHETIC_PRIVATE' }, code: 'NOT_AUTHORIZED' },
    { name: 'parse', observation: { code: 0, stdout: 'SYNTHETIC_PRIVATE_PARSE', stderr: '' }, code: 'PARTIAL_INSTALL' },
    { name: 'OS', observation: { code: 255, stdout: '', stderr: 'SYNTHETIC_PRIVATE_OS_ERROR' }, code: 'PARTIAL_INSTALL' },
    { name: 'inexact absence', observation: { ...absent('core'), stderr: `${absent('core').stderr}extra\n` }, code: 'PARTIAL_INSTALL' },
  ];
  it.each(errors)('does not retry an immediate $name print failure', async ({ observation, code }) => {
    const { seen, services } = harness((action, call) => action === 'print'
      ? call === 1 ? present('core') : observation : completed);
    const pending = stopping(services);
    await vi.advanceTimersByTimeAsync(0); await pending.work;
    expect(pending.result()).toEqual({ ok: false, code });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(actions(seen)).toEqual(['print', 'disable', 'bootout', 'print']);
    expect(JSON.stringify(pending.result())).not.toContain('SYNTHETIC');
  });

  it.each(errors)('stops polling immediately on a later $name print failure', async ({ observation, code }) => {
    const { seen, services } = harness((action, call) => action === 'print'
      ? call <= 4 ? present('core') : observation : completed);
    const pending = stopping(services);
    await vi.advanceTimersByTimeAsync(199);
    expect(pending.result()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1); await pending.work;
    expect(pending.result()).toEqual({ ok: false, code });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(actions(seen)).toEqual(['print', 'disable', 'bootout', 'print', 'print']);
    expect(JSON.stringify(pending.result())).not.toContain('SYNTHETIC');
  });

  it.each([1, 113, 255])('does not poll after bootout code %i and a valid present print', async code => {
    const { seen, services } = harness(action => action === 'print' ? present('core')
      : action === 'bootout' ? { code, stdout: '', stderr: 'Operation not permitted SYNTHETIC_PRIVATE' } : completed);
    const pending = stopping(services);
    await vi.advanceTimersByTimeAsync(0); await pending.work;
    expect(pending.result()).toEqual({ ok: false, code: 'PARTIAL_INSTALL' });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(actions(seen)).toEqual(['print', 'disable', 'bootout', 'print']);
  });

  it.each([1, 113, 255])('retains timely strict absence success immediately after bootout code %i', async code => {
    const { seen, services } = harness((action, call) => {
      if (action === 'print') return call === 1 ? present('core') : absent('core');
      return action === 'bootout' ? delayed({ code, stdout: '', stderr: 'SYNTHETIC_PRIVATE' }, 29_999) : completed;
    });
    const pending = stopping(services);
    await vi.advanceTimersByTimeAsync(29_999); await pending.work;
    expect(pending.result()).toEqual({ ok: true, code: 'OK' });
    expect(actions(seen)).toEqual(['print', 'disable', 'bootout', 'print']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['bootout', 'print'] as const)('does not retry or expose a rejected %s', async stage => {
    const { seen, services } = harness((action, call) => {
      if (call === 1) return present('core');
      if (action === stage) throw new Error('SYNTHETIC_PRIVATE_COMMAND_FAILURE');
      return completed;
    });
    const pending = stopping(services);
    await vi.advanceTimersByTimeAsync(0); await pending.work;
    expect(pending.result()).toEqual({ ok: false, code: 'INTERNAL_ERROR' });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(actions(seen)).toEqual(stage === 'bootout'
      ? ['print', 'disable', 'bootout'] : ['print', 'disable', 'bootout', 'print']);
  });

  it.each(['core', 'tunnel'] as const)('leaves an initially absent %s job untouched without a termination timer', async role => {
    const { seen, services } = harness(() => absent(role));
    const pending = stopping(services, role);
    await vi.advanceTimersByTimeAsync(0); await pending.work;
    expect(pending.result()).toEqual({ ok: true, code: 'OK' });
    expect(seen.map(call => call.argv)).toEqual([launchctlVector('print', role)]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
