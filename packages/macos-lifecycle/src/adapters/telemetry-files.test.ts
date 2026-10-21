import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createTelemetryFilesAt } from './telemetry-files.js';
import { createCircuitFilesAt, type CircuitFileIo, type StateDirectoryPolicy } from './service-files.js';
import { encodeHistory } from '../lifecycle-store.js';
import { freshHistory } from '../circuit.js';
import { TelemetryStore } from '../telemetry-store.js';
import { attachChildOutput } from '../child-output.js';
import { encodeEvent, encodeStatus } from '../telemetry.js';
import { LOG_MAX_BYTES, decodeEventSegment } from '../event-log.js';
const event = (observedAtMs = 1000) => ({ schemaVersion: 1, role: 'core', generation: 'gen-1', releaseDigest: 'a'.repeat(64), code: 'OK', observedAtMs, attemptCount: 0 });
const status = (time = 1000) => ({ ...event(time), state: 'LOCAL_CORE_HEALTHY' });
const owner = { role: 'core' as const, generation: 'gen-1', releaseDigest: 'a'.repeat(64) };
const digest = (b: Buffer | null) => b === null ? null : createHash('sha256').update(b).digest('hex');
let anchor: string;
const policy = (relative: string): StateDirectoryPolicy => ({ anchor, relative, ancestorUid: process.getuid?.() ?? -1, stateUid: process.getuid?.() ?? -1, acl: async () => true });
const files = (io?: CircuitFileIo) => createTelemetryFilesAt(policy('run'), policy('logs'), io);
beforeEach(async () => {
  anchor = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'gram telemetry ')));
  await fs.chmod(anchor, 0o700); await fs.mkdir(join(anchor, 'run'), { mode: 0o700 }); await fs.mkdir(join(anchor, 'logs'), { mode: 0o700 });
});
afterEach(async () => { await fs.rm(anchor, { recursive: true, force: true }); });
describe('fixed private telemetry files', () => {
  it('keeps status, events and existing circuit history separate across reload', async () => {
    const f = files(); const store = new TelemetryStore(f.status, f.events);
    const circuit = createCircuitFilesAt(policy('run')); const bytes = encodeHistory(freshHistory(0));
    await circuit.compareAndSwap('core', null, bytes);
    await store.writeStatus('core', status(), owner); await store.appendEvent('core', event());
    expect((await fs.readFile(join(anchor, 'run/core.circuit.json'))).equals(bytes)).toBe(true);
    expect(await fs.readdir(join(anchor, 'run'))).toEqual(['core.circuit.json', 'core.status.json']);
    expect(await fs.readdir(join(anchor, 'logs'))).toEqual(['core.events.0.jsonl']);
    expect((await fs.stat(join(anchor, 'run/core.status.json'))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(join(anchor, 'logs/core.events.0.jsonl'))).mode & 0o777).toBe(0o600);
    const reload = files(); expect((await new TelemetryStore(reload.status, reload.events).readStatus('core', owner, 1001))?.generation).toBe('gen-1');
    expect(await reload.status.read('tunnel')).toEqual([null]); expect(await reload.events.read('tunnel')).toEqual([null, null, null]);
  });
  it('publishes one new segment atomically while retaining the other two full files', async () => {
    const line = encodeEvent(event()); const old: Buffer[] = [];
    for (let i = 0; i < 3; i++) {
      const header = Buffer.from(JSON.stringify({ schemaVersion: 1, sequence: i }) + '\n');
      const bytes = Buffer.concat([header, Buffer.from(line.toString().repeat(Math.floor((LOG_MAX_BYTES - header.length) / line.length)))]);
      old.push(bytes); await fs.writeFile(join(anchor, `logs/core.events.${i}.jsonl`), bytes, { mode: 0o600 });
    }
    const f = files(); await new TelemetryStore(f.status, f.events).appendEvent('core', event(2000));
    expect((await fs.readdir(join(anchor, 'logs'))).sort()).toEqual(['core.events.0.jsonl', 'core.events.1.jsonl', 'core.events.2.jsonl']);
    const current = await fs.readFile(join(anchor, 'logs/core.events.0.jsonl'));
    expect(decodeEventSegment(current, 'core', 0).sequence).toBe(3);
    for (let i = 1; i < 3; i++) {
      const prior = old[i]; if (!prior) throw new Error('MISSING_TEST_BYTES');
      expect((await fs.readFile(join(anchor, `logs/core.events.${i}.jsonl`))).equals(prior)).toBe(true);
    }
    for (const name of await fs.readdir(join(anchor, 'logs'))) expect((await fs.stat(join(anchor, 'logs', name))).size).toBeLessThanOrEqual(LOG_MAX_BYTES);
  }, 15000);
  it('compares the whole event group even when the intended slot remains absent', async () => {
    const f = files(); const stale = (await f.events.read('core')).map(digest);
    await new TelemetryStore(f.status, f.events).appendEvent('core', event());
    const second = Buffer.concat([Buffer.from('{"schemaVersion":1,"sequence":1}\n'), encodeEvent(event(2000))]);
    await expect(f.events.compareAndSwap('core', stale, 1, second)).rejects.toThrow(/^STATE_CONFLICT$/);
    expect(await fs.readdir(join(anchor, 'logs'))).toEqual(['core.events.0.jsonl']);
  });
  it('fences independent status writers and preserves a foreign lock', async () => {
    const a = files(); const b = files();
    const results = await Promise.allSettled([a.status.compareAndSwap('core', [null], 0, encodeStatus(status())), b.status.compareAndSwap('core', [null], 0, encodeStatus(status(2000)))]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    await fs.writeFile(join(anchor, 'logs/core.events.lock'), 'foreign-lock', { mode: 0o600 });
    await expect(new TelemetryStore(a.status, a.events).appendEvent('core', event())).rejects.toThrow(/^BUSY$/);
    expect(await fs.readFile(join(anchor, 'logs/core.events.lock'), 'utf8')).toBe('foreign-lock');
  });
  it.each(['symlink', 'hardlink', 'directory', 'public-file'])('refuses a %s status target without modifying foreign data', async kind => {
    const path = join(anchor, 'run/core.status.json'); const outside = join(anchor, 'outside');
    await fs.writeFile(outside, 'preserve-foreign', { mode: 0o600 });
    if (kind === 'symlink') await fs.symlink(outside, path);
    else if (kind === 'hardlink') await fs.link(outside, path);
    else if (kind === 'directory') await fs.mkdir(path);
    else await fs.writeFile(path, encodeStatus(status()), { mode: 0o644 });
    const f = files(); await expect(f.status.read('core')).rejects.toThrow(/^UNSAFE_PATH$/);
    await expect(new TelemetryStore(f.status, f.events).writeStatus('core', status(2000), owner)).rejects.toThrow(/^UNSAFE_PATH$/);
    expect(await fs.readFile(outside, 'utf8')).toBe('preserve-foreign');
  });
  it('refuses untrusted directory ACLs and missing directories without provisioning them', async () => {
    const f = createTelemetryFilesAt({ ...policy('run'), acl: async () => false }, policy('missing'));
    await expect(f.status.read('core')).rejects.toThrow(/^UNSAFE_PATH$/);
    await expect(f.events.read('core')).rejects.toThrow(/^UNSAFE_PATH$/);
    expect((await fs.readdir(anchor)).sort()).toEqual(['logs', 'run']);
  });
  it('rejects unknown roles, slot layouts, event bytes and oversized status before writes', async () => {
    const f = files();
    await expect(f.status.read('../secret' as 'core')).rejects.toThrow(/^INVALID_TELEMETRY$/);
    await expect(f.status.compareAndSwap('core', [null], 1, encodeStatus(status()))).rejects.toThrow(/^INVALID_TELEMETRY$/);
    await expect(f.events.compareAndSwap('core', [null], 0, Buffer.from('secret'))).rejects.toThrow(/^INVALID_TELEMETRY$/);
    await expect(f.status.compareAndSwap('core', [null], 0, Buffer.alloc(65537))).rejects.toThrow(/^INVALID_TELEMETRY$/);
    expect(await fs.readdir(join(anchor, 'run'))).toEqual([]); expect(await fs.readdir(join(anchor, 'logs'))).toEqual([]);
  });
  it('retains complete prior status after a rename failure and discards raw I/O errors', async () => {
    const f = files(); const store = new TelemetryStore(f.status, f.events); await store.writeStatus('core', status(), owner);
    const broken = files({ ...fs, rename: async () => { throw new Error('SYNTHETIC_SECRET'); } });
    await expect(new TelemetryStore(broken.status, broken.events).writeStatus('core', status(2000), owner)).rejects.toThrow(/^STATE_IO$/);
    expect((await fs.readFile(join(anchor, 'run/core.status.json'))).equals(encodeStatus(status()))).toBe(true);
    expect(await fs.readdir(join(anchor, 'run'))).toEqual(['core.status.json']);
  });
  it('returns unknown durability without undoing a completed rename', async () => {
    const f = files(); const store = new TelemetryStore(f.status, f.events); await store.writeStatus('core', status(), owner);
    const broken = files({ ...fs, open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (String(args[0]) === join(anchor, 'run')) handle.sync = async () => { throw new Error('SYNTHETIC_SECRET'); };
      return handle;
    } });
    await expect(new TelemetryStore(broken.status, broken.events).writeStatus('core', status(2000), owner)).rejects.toThrow(/^STATE_IO$/);
    expect((await fs.readFile(join(anchor, 'run/core.status.json'))).equals(encodeStatus(status(2000)))).toBe(true);
  });
  it('never persists fragmented child bytes or environment-shaped strings', async () => {
    const f = files(); const store = new TelemetryStore(f.status, f.events);
    const out = new PassThrough(); const err = new PassThrough(); const drain = attachChildOutput(out, err);
    out.write('SYNTHETIC_'); out.end('SECRET'); err.end('TOKEN=never-retain\nCOOKIE=private');
    expect(await drain.finish()).toBe('DRAINED'); await store.writeStatus('core', status(), owner); await store.appendEvent('core', event());
    for (const dir of ['run', 'logs']) for (const name of await fs.readdir(join(anchor, dir))) {
      const bytes = await fs.readFile(join(anchor, dir, name), 'utf8');
      expect(bytes).not.toMatch(/SYNTHETIC_|SECRET|never-retain|COOKIE|TOKEN=/u);
    }
  });
});
