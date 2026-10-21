import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { freshHistory } from './circuit.js';
import { decodeHistory, encodeHistory, LifecycleStore, type CircuitFiles } from './lifecycle-store.js';
import type { Role } from './contracts.js';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
function fixture() {
  const disk = new Map<Role, Buffer>(); let commits = 0;
  const files: CircuitFiles = {
    async read(role) { const b = disk.get(role); return b ? Buffer.from(b) : null; },
    async compareAndSwap(role, expected, bytes) {
      const current = disk.get(role);
      if ((current ? sha(current) : null) !== expected) throw new Error('STATE_CONFLICT');
      disk.set(role, Buffer.from(bytes)); commits++;
    },
  };
  return { disk, files, store: new LifecycleStore(files), commits: () => commits };
}
describe('canonical bounded history', () => {
  it('roundtrips detached strictly typed history', () => {
    const original = freshHistory(0); const bytes = encodeHistory(original);
    expect(bytes.at(-1)).toBe(10); expect(decodeHistory(bytes)).toEqual(original);
    const result = decodeHistory(bytes); result.exitsMs.push(1);
    expect(decodeHistory(bytes)).toEqual(original);
  });
  it.each([Buffer.from(''), Buffer.from('{'), Buffer.from([0xff]), Buffer.alloc(65537),
    Buffer.from('{}\n'), Buffer.from('null\n'), Buffer.from('{"message":"synthetic-sensitive"}\n')])('refuses malformed bytes %#', b => {
    expect(() => decodeHistory(b)).toThrow(/^INVALID_HISTORY$/);
  });
  it('refuses duplicate fields, unknown fields, whitespace and noncanonical encodings', () => {
    const text = encodeHistory(freshHistory(1)).toString('utf8');
    for (const bad of [' ' + text, text.replace('"blocked":false', '"blocked":true,"blocked":false'),
      text.replace('"blocked":false', '"blocked":false,"raw":"synthetic-sensitive"'), '\uFEFF' + text]) {
      expect(() => decodeHistory(Buffer.from(bad))).toThrow(/^INVALID_HISTORY$/);
    }
  });
});
describe('durable transition boundary', () => {
  it('missing history is not an implicit fresh installation', async () => {
    const f = fixture(); await expect(f.store.read('core')).rejects.toThrow(/^MISSING_HISTORY$/);
    expect(f.commits()).toBe(0); expect(f.disk.size).toBe(0);
  });
  it('only explicit create-only initialization creates state', async () => {
    const f = fixture(); const h = await f.store.initializeNew('core', 0);
    expect(h).toEqual({ role: 'core', history: freshHistory(0), digest: sha(encodeHistory(freshHistory(0))) });
    await expect(f.store.initializeNew('core', 1)).rejects.toThrow(/^STATE_CONFLICT$/);
    expect(f.commits()).toBe(1); expect((await f.store.read('core')).history.lastSeenMs).toBe(0);
  });
  it('recovers an active marker across store instances exactly once', async () => {
    const f = fixture(); let h = await f.store.initializeNew('core', 0);
    await f.store.write('core', h, { kind: 'begin', generation: 'g1', nowMs: 1 });
    const restarted = new LifecycleStore(f.files);
    h = await restarted.write('core', await restarted.read('core'), { kind: 'recover', nowMs: 2 });
    expect(h.history.exitsMs).toEqual([2]);
    h = await new LifecycleStore(f.files).write('core', h, { kind: 'recover', nowMs: 3 });
    expect(h.history.exitsMs).toEqual([2]);
  });
  it('rejects stale concurrent snapshots rather than losing a failure', async () => {
    const f = fixture(); const h = await f.store.initializeNew('core', 0);
    await f.store.write('core', h, { kind: 'begin', generation: 'g1', nowMs: 1 });
    await expect(f.store.write('core', h, { kind: 'begin', generation: 'g2', nowMs: 1 })).rejects.toThrow(/^STATE_CONFLICT$/);
    expect((await f.store.read('core')).history.activeAttempt?.generation).toBe('g1');
  });
  it('ties exit records to the active generation and refuses duplicate reports', async () => {
    const f = fixture(); let h = await f.store.initializeNew('core', 0);
    h = await f.store.write('core', h, { kind: 'begin', generation: 'g1', nowMs: 1 });
    await expect(f.store.write('core', h, { kind: 'exit', generation: 'other', nowMs: 2, intentional: false })).rejects.toThrow(/^INVALID_HISTORY$/);
    h = await f.store.write('core', h, { kind: 'exit', generation: 'g1', nowMs: 2, intentional: false });
    await expect(f.store.write('core', h, { kind: 'exit', generation: 'g1', nowMs: 3, intentional: false })).rejects.toThrow(/^INVALID_HISTORY$/);
    expect((await f.store.read('core')).history.exitsMs).toEqual([2]);
  });
  it('does not return a started marker until the durable write resolves', async () => {
    const f = fixture(); const h = await f.store.initializeNew('core', 0);
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const port: CircuitFiles = { read: f.files.read, async compareAndSwap(r, d, b) { await gate; await f.files.compareAndSwap(r, d, b); } };
    let done = false;
    const pending = new LifecycleStore(port).write('core', h, { kind: 'begin', generation: 'g1', nowMs: 1 }).then(v => { done = true; return v; });
    await Promise.resolve(); expect(done).toBe(false); expect(f.commits()).toBe(1);
    release(); expect((await pending).history.activeAttempt?.generation).toBe('g1');
  });
  it('contains provider errors and never treats failed durability as success', async () => {
    const f = fixture(); const h = await f.store.initializeNew('core', 0);
    const original = f.disk.get('core'); if (!original) throw new Error('MISSING_FIXTURE');
    const before = Buffer.from(original);
    const broken: CircuitFiles = { read: f.files.read, async compareAndSwap() { throw new Error('synthetic-sensitive disk failure'); } };
    await expect(new LifecycleStore(broken).write('core', h, { kind: 'begin', generation: 'g1', nowMs: 1 })).rejects.toThrow(/^STATE_IO$/);
    expect(f.disk.get('core')).toEqual(before);
  });
  it('propagates ambiguous post-commit failures without retrying old state', async () => {
    const f = fixture(); const h = await f.store.initializeNew('core', 0);
    const broken: CircuitFiles = { read: f.files.read, async compareAndSwap(r, d, b) { await f.files.compareAndSwap(r, d, b); throw new Error('directory sync failed'); } };
    await expect(new LifecycleStore(broken).write('core', h, { kind: 'begin', generation: 'g1', nowMs: 1 })).rejects.toThrow(/^STATE_IO$/);
    const next = await f.store.read('core'); expect(next.history.activeAttempt?.generation).toBe('g1');
    expect(f.commits()).toBe(2);
  });
  it('does not overwrite or reset corrupt existing history', async () => {
    const f = fixture(); const bad = Buffer.from('{"blocked":'); f.disk.set('core', bad);
    await expect(f.store.read('core')).rejects.toThrow(/^INVALID_HISTORY$/);
    await expect(f.store.initializeNew('core', 0)).rejects.toThrow(/^STATE_CONFLICT$/);
    expect(f.disk.get('core')).toEqual(bad); expect(f.commits()).toBe(0);
  });
  it('keeps role histories separate and rejects cross-role snapshots', async () => {
    const f = fixture(); const c = await f.store.initializeNew('core', 0);
    await f.store.initializeNew('tunnel', 0);
    await expect(f.store.write('tunnel', c, { kind: 'begin', generation: 'g1', nowMs: 1 })).rejects.toThrow(/^INVALID_HISTORY$/);
    expect((await f.store.read('tunnel')).history.activeAttempt).toBeNull();
  });
  it('refuses a caller-mutated snapshot before any write', async () => {
    const f = fixture(); const h = await f.store.initializeNew('core', 0); h.history.lastSeenMs = 1;
    await expect(f.store.write('core', h, { kind: 'begin', generation: 'g1', nowMs: 2 })).rejects.toThrow(/^INVALID_HISTORY$/);
    expect(f.commits()).toBe(1);
  });
  it('rejects arbitrary fields and unsafe roles without persisting them', async () => {
    const f = fixture(); const h = await f.store.initializeNew('core', 0);
    await expect(f.store.read('../secret' as never)).rejects.toThrow(/^INVALID_HISTORY$/);
    await expect(f.store.write('core', h, { kind: 'recover', nowMs: 1, raw: 'synthetic-sensitive' } as never)).rejects.toThrow(/^INVALID_HISTORY$/);
    expect(f.commits()).toBe(1);
  });
  it('reloads a sticky blocked circuit and requires explicit generation-bound reset', async () => {
    const f = fixture(); let h = await f.store.initializeNew('core', 0);
    for (let n = 1; n <= 5; n++) {
      h = await f.store.write('core', h, { kind: 'begin', generation: `g${n}`, nowMs: n * 10 });
      h = await f.store.write('core', h, { kind: 'recover', nowMs: n * 10 + 1 });
    }
    h = await new LifecycleStore(f.files).read('core'); expect(h.history.blocked).toBe(true);
    await expect(f.store.write('core', h, { kind: 'begin', generation: 'g6', nowMs: 900000 })).rejects.toThrow(/^RESTART_BUDGET$/);
    h = await f.store.write('core', h, { kind: 'reset', generation: 'g5', nowMs: 900000 });
    expect(h.history.blocked).toBe(false); expect(h.history.activeAttempt).toBeNull();
  });
});
