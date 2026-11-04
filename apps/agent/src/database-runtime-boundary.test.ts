import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createConnection, type Connection, type ConnectionConfig } from 'mariadb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretRedactor } from '@gram/secrets';
import { createDatabaseRuntime, type DatabaseRuntime } from './database-runtime.js';
import type { ReadonlyDatabaseConfig } from './database-config.js';

const transport = vi.hoisted(() => ({ sockets: [] as { destroyed: boolean }[], events: [] as string[] }));
vi.mock('mariadb', () => ({ createConnection: vi.fn() }));
vi.mock('node:net', async importOriginal => {
  const original = await importOriginal<typeof import('node:net')>();
  const { EventEmitter: Emitter } = await import('node:events');
  class FixtureSocket extends Emitter {
    destroyed = false;
    constructor() { super();transport.sockets.push(this); }
    connect() { void Promise.resolve().then(() => this.emit('connect'));return this; }
    destroy(error?: Error) {
      if (!this.destroyed) {
        this.destroyed = true;
        void Promise.resolve().then(() => {
          if (error && this.listenerCount('error')) this.emit('error', error);
          transport.events.push('socket-close');this.emit('close');
        });
      }
      return this;
    }
  }
  return { ...original, Socket: FixtureSocket };
});

const config: ReadonlyDatabaseConfig = { version: 1, connections: [{ id: 'business', engine: 'mysql', host: '127.0.0.1',
  port: 3306, database: 'fixture', user: 'reader', passwordSecret: 'database-readonly-business', tls: false,
  maxRows: 500, maxBytes: 1048576, timeoutMs: 1000 }] };
const input = { connectionId: 'business', sql: 'SELECT 42 AS answer' };
let runtime: DatabaseRuntime | undefined;
let releaseHangs = () => {};

function fixture(settings: { identityHang?: boolean; targetEndFails?: boolean; grantRows?: number; grantBytes?: number; verifiedControlHang?: boolean; rollbackHang?: boolean; userStreamError?: boolean; killKeepsBusy?: boolean } = {}) {
  const buffered = vi.fn();
  const pending: (() => void)[] = [];
  const state = { identitySeen: false, prepared: false, killSeen: false, rollbackSeen: false, processListSeen: 0,
    busy: false, failUser: () => {}, confirmKill: () => {} };
  let index = 0;
  releaseHangs = () => { for (const release of pending.splice(0)) release(); };
  vi.mocked(createConnection).mockImplementation(async raw => {
    const current = ++index;
    let socket: (EventEmitter & { destroyed: boolean; destroy(error?: Error): unknown }) | undefined;
    const factory = (raw as ConnectionConfig).stream;
    if (factory) socket = await new Promise((resolve, reject) => factory((error, value) => {
      if (error) reject(error);
      else resolve(value as unknown as NonNullable<typeof socket>);
    }));
    let ended = false, invalid = false;
    const text = (value: unknown) => typeof value === 'string' ? value : String((value as { sql: unknown }).sql);
    const rows = (sql: string): unknown[][] => {
      if (sql.startsWith('SELECT CONNECTION_ID()')) {
        state.identitySeen = true;
        return [[String(current), 'fixture-server', 'reader@localhost', '8.4.3']];
      }
      if (sql === 'SHOW GRANTS') {
        const grant = "GRANT SELECT ON `fixture`.* TO `reader`@`localhost`";
        return Array.from({ length: settings.grantRows ?? 1 }, () => [grant.padEnd(settings.grantBytes ?? grant.length, ' ')]);
      }
      if (sql.startsWith('KILL QUERY ')) state.killSeen = true;
      if (sql === 'ROLLBACK') state.rollbackSeen = true;
      if (sql === 'SHOW PROCESSLIST') {
        state.processListSeen++;
        return [[2, 'reader', 'localhost', 'fixture', state.busy ? 'Query' : 'Sleep', 0, '', 'SELECT 42']];
      }
      return [];
    };
    const hang = (sql: string) => (current === 1 && ((settings.identityHang && sql.startsWith('SELECT CONNECTION_ID()')) ||
      (settings.verifiedControlHang && sql.startsWith('KILL QUERY ')))) ||
      (current === 2 && settings.rollbackHang && sql === 'ROLLBACK');
    const stream = (data: unknown[], names: string[], stalled = false) => {
      const result = new Readable({ objectMode: true, read() {} });
      result.on('error', () => {});
      const release = () => result.destroy(new Error('Fixture transport closed'));
      if (socket?.destroyed || invalid) { void Promise.resolve().then(release);return result; }
      socket?.once('close', release);
      result.once('close', () => socket?.removeListener('close', release));
      if (stalled) pending.push(release);
      else void Promise.resolve().then(() => {
        if (result.destroyed) return;
        if (names.length) result.emit('fields', names.map(name => ({ name: () => name })));
        for (const row of data) result.push(row);
        result.push(null);
      });
      return result;
    };
    const connection = Object.assign(new EventEmitter(), {
      threadId: current,
      query: vi.fn(async (value: unknown) => {
        buffered();if (socket?.destroyed || invalid) throw new Error('Fixture transport closed');
        const sql = text(value);const values = rows(sql);
        if (hang(sql)) return await new Promise<unknown[][]>((_resolve, reject) => {
          const release = () => reject(new Error('Fixture transport closed'));
          pending.push(release);socket?.once('close', release);
        });
        return values;
      }),
      queryStream: vi.fn((value: unknown) => {
        if (socket?.destroyed || invalid) return stream([], []);
        const sql = text(value);const values = rows(sql);
        const command = sql.startsWith('SET SESSION ') || sql === 'START TRANSACTION READ ONLY' ||
          sql.startsWith('KILL QUERY ') || sql === 'ROLLBACK';
        const ok = { affectedRows: 0, insertId: 0n, warningStatus: 0 };
        if (settings.userStreamError && current === 1 && sql.startsWith('KILL QUERY ')) {
          const result = stream([], [], true);
          state.confirmKill = () => { state.busy = settings.killKeepsBusy === true;result.push(ok);result.push(null); };
          return result;
        }
        return stream(command ? [ok] : values, command ? [] : values[0]?.map((_cell, column) => 'column' + column) ?? [], Boolean(hang(sql)));
      }),
      prepare: vi.fn(async () => {
        state.prepared = true;
        if (socket?.destroyed || invalid) throw new Error('Fixture transport closed');
        return { close() {}, executeStream: () => {
          if (settings.userStreamError) {
            state.busy = true;
            const result = stream([], [], true);
            state.failUser = () => { invalid = true;result.destroy(new Error('Fixture user stream failed')); };
            return result;
          }
          return stream([[42]], ['answer'], settings.verifiedControlHang);
        } };
      }),
      isValid: () => !ended && !invalid && socket?.destroyed !== true,
      end: vi.fn(async () => {
        if (settings.targetEndFails && current === 2) throw new Error('test-only-password cleanup failure');
        ended = true;socket?.destroy();
      }),
    });
    return connection as unknown as Connection;
  });
  const dispose = vi.fn(() => { transport.events.push('lease-dispose'); });
  runtime = createDatabaseRuntime({ config, redactor: new SecretRedactor(), secrets: {
    getForUse: vi.fn(async () => ({ withValue: <T>(use: (password: string) => T): T => use('test-only-password'), dispose })),
  } });
  return { runtime, buffered, dispose, state };
}
async function ticks() { for (let i = 0; i < 50; i++) await Promise.resolve(); }

beforeEach(() => { transport.sockets.length = 0;transport.events.length = 0;vi.mocked(createConnection).mockReset(); });
afterEach(async () => {
  releaseHangs();
  await runtime?.close().catch(() => {});
  runtime = undefined;vi.useRealTimers();
});

describe('database driver resource boundaries (mocked protocol, not SQL authority)', () => {
  it('uses bounded metadata streams instead of buffered controller queries', async () => {
    const { runtime: current, buffered } = fixture();
    expect(await current.tools.select(input, new AbortController().signal)).toEqual({ columns: ['answer'], rows: [[42]], truncated: false });
    expect(buffered).not.toHaveBeenCalled();
  });

  it('settles a pre-identity timeout only after closing owned sockets and disposing the lease', async () => {
    vi.useFakeTimers();
    const { runtime: current, dispose, state } = fixture({ identityHang: true });
    let outcome = 'pending';
    const operation = current.tools.select(input, new AbortController().signal).then(
      () => { outcome = 'resolved'; }, () => { outcome = 'rejected'; },
    );
    try {
      await ticks();expect(state.identitySeen).toBe(true);expect(state.prepared).toBe(false);
      await vi.advanceTimersByTimeAsync(1001);await ticks();
      expect(outcome).toBe('rejected');
      expect(transport.sockets).toHaveLength(2);
      expect(transport.sockets.every(socket => socket.destroyed)).toBe(true);
      expect(dispose).toHaveBeenCalledOnce();
      expect(transport.events.indexOf('lease-dispose')).toBeGreaterThan(transport.events.lastIndexOf('socket-close'));
    } finally { releaseHangs();await operation; }
  });

  it.each([
    { name: '257 metadata rows', grantRows: 257 },
    { name: 'more than 64 KiB of metadata', grantBytes: 65537 },
  ])('closes and quarantines $name before preparing user SQL', async settings => {
    const { runtime: current, buffered, dispose, state } = fixture(settings);
    await expect(current.tools.select(input, new AbortController().signal)).rejects.toThrow('Database operation denied or failed');
    expect(state.prepared).toBe(false);
    expect(buffered).not.toHaveBeenCalled();
    expect(transport.sockets).toHaveLength(2);
    expect(transport.sockets.every(socket => socket.destroyed)).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
    expect(transport.events.indexOf('lease-dispose')).toBeGreaterThan(transport.events.lastIndexOf('socket-close'));
    await expect(current.close()).rejects.toThrow('Database operation denied or failed');
  });

  it('closes owned transports at the cleanup deadline when verified user SQL and its KILL both stall', async () => {
    vi.useFakeTimers();
    const { runtime: current, dispose, state } = fixture({ verifiedControlHang: true });
    let outcome = 'pending';
    const operation = current.tools.select(input, new AbortController().signal).then(
      () => { outcome = 'resolved'; }, () => { outcome = 'rejected'; },
    );
    try {
      await vi.advanceTimersByTimeAsync(0);await ticks();
      expect(state.prepared).toBe(true);
      await vi.advanceTimersByTimeAsync(1001);await ticks();
      expect(state.killSeen).toBe(true);expect(outcome).toBe('pending');
      expect(dispose).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5001);await ticks();
      expect(outcome).toBe('rejected');
      expect(transport.sockets).toHaveLength(2);
      expect(transport.sockets.every(socket => socket.destroyed)).toBe(true);
      expect(dispose).toHaveBeenCalledOnce();
      expect(transport.events.indexOf('lease-dispose')).toBeGreaterThan(transport.events.lastIndexOf('socket-close'));
      await expect(current.close()).rejects.toThrow('Database operation denied or failed');
    } finally { releaseHangs();await vi.advanceTimersByTimeAsync(6001);await operation; }
  });

  it('keeps the timeout armed while the final rollback stalls after successful SELECT', async () => {
    vi.useFakeTimers();
    const { runtime: current, dispose, state } = fixture({ rollbackHang: true });
    let outcome = 'pending';
    const operation = current.tools.select(input, new AbortController().signal).then(
      () => { outcome = 'resolved'; }, () => { outcome = 'rejected'; },
    );
    try {
      await vi.advanceTimersByTimeAsync(0);await ticks();
      expect(state.prepared).toBe(true);expect(state.rollbackSeen).toBe(true);
      await vi.advanceTimersByTimeAsync(6001);await ticks();
      expect(outcome).toBe('rejected');
      expect(transport.sockets).toHaveLength(2);
      expect(transport.sockets.every(socket => socket.destroyed)).toBe(true);
      expect(dispose).toHaveBeenCalledOnce();
      expect(transport.events.indexOf('lease-dispose')).toBeGreaterThan(transport.events.lastIndexOf('socket-close'));
      await expect(current.close()).rejects.toThrow('Database operation denied or failed');
    } finally { releaseHangs();await vi.advanceTimersByTimeAsync(6001);await operation; }
  });

  it.each([
    { command: 'Sleep', killKeepsBusy: false },
    { command: 'Query', killKeepsBusy: true },
  ])('retains the lease through unexpected stream failure and inspects $command proof', async settings => {
    vi.useFakeTimers();
    const { runtime: current, dispose, state } = fixture({ userStreamError: true, killKeepsBusy: settings.killKeepsBusy });
    let outcome = 'pending';
    const operation = current.tools.select(input, new AbortController().signal).then(
      () => { outcome = 'resolved'; }, () => { outcome = 'rejected'; },
    );
    try {
      await vi.advanceTimersByTimeAsync(0);await ticks();expect(state.prepared).toBe(true);
      state.failUser();await vi.advanceTimersByTimeAsync(0);await ticks();
      expect(state.killSeen).toBe(true);expect(outcome).toBe('pending');
      expect(dispose).not.toHaveBeenCalled();expect(state.busy).toBe(true);
      state.confirmKill();await vi.advanceTimersByTimeAsync(0);await ticks();await operation;
      expect(outcome).toBe('rejected');expect(state.processListSeen).toBeGreaterThan(0);
      expect(transport.sockets).toHaveLength(2);
      expect(transport.sockets.every(socket => socket.destroyed)).toBe(true);
      expect(dispose).toHaveBeenCalledOnce();
      expect(transport.events.indexOf('lease-dispose')).toBeGreaterThan(transport.events.lastIndexOf('socket-close'));
      if (settings.killKeepsBusy) await expect(current.close()).rejects.toThrow('Database operation denied or failed');
      else await expect(current.close()).resolves.toBeUndefined();
    } finally { state.confirmKill();releaseHangs();await vi.advanceTimersByTimeAsync(6001);await operation; }
  });

  it('rejects close after cleanup leaves a query quarantined', async () => {
    const { runtime: current } = fixture({ targetEndFails: true });
    await expect(current.tools.select(input, new AbortController().signal)).rejects.toThrow('Database operation denied or failed');
    await expect(current.close()).rejects.toThrow('Database operation denied or failed');
  });
});
