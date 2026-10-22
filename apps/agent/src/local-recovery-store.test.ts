import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalRecoveryStore } from './local-recovery-store.js';

const created: string[] = [];
function directory() {const path = mkdtempSync(join(tmpdir(), 'gram-owner-recovery-'));created.push(path);return path;}
const context = { rootId: 'fixture', rootIdentity: '1:2', path: '.env', sourceIdentity: '1:3', operation: 'write' as const };
afterEach(() => { for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true }); });
describe('private authenticated recovery storage', () => {
  it('restores by an authenticated exact root and path while retaining original internal context', () => {
    const store = new LocalRecoveryStore({ stateDirectory: directory() });
    const record = store.capture(context, Buffer.from('original'));
    expect(store.readForTarget(record.recoveryId, { rootId: 'fixture', rootIdentity: '1:2', path: '.env' }))
      .toEqual({ context, bytes: Buffer.from('original') });
    for (const target of [{ rootId: 'other', rootIdentity: '1:2', path: '.env' },
      { rootId: 'fixture', rootIdentity: '1:9', path: '.env' }, { rootId: 'fixture', rootIdentity: '1:2', path: 'other' }]) {
      expect(() => store.readForTarget(record.recoveryId, target)).toThrow();
    }
  });
  it('recovers exact bytes after restart without plaintext credential or path persistence', () => {
    const stateDirectory = directory();const store = new LocalRecoveryStore({ stateDirectory });
    const bytes = Buffer.from('PASSWORD=synthetic-private-recovery-fixture\n');
    const record = store.capture(context, bytes);
    const version = store.version(context, bytes);
    const restarted = new LocalRecoveryStore({ stateDirectory });
    expect(restarted.read(record.recoveryId, context)).toEqual(bytes);
    expect(restarted.version(context, bytes)).toBe(version);
    const recoveryDir = join(stateDirectory, 'local-owner-recovery');
    const persisted = readdirSync(recoveryDir).map(name => readFileSync(join(recoveryDir, name)).toString('utf8')).join('\n');
    expect(persisted).not.toContain('synthetic-private-recovery-fixture');
    expect(persisted).not.toContain('.env');
  });
  it('denies another root identity, target, operation or tampered ciphertext', () => {
    const stateDirectory = directory();const store = new LocalRecoveryStore({ stateDirectory });
    const record = store.capture(context, Buffer.from('fixture-original'));
    for (const changed of [{ rootId: 'other' }, { rootIdentity: '1:9' }, { path: 'other' }, { operation: 'trash' as const }]) {
      expect(() => store.read(record.recoveryId, { ...context, ...changed })).toThrow(/Recovery operation denied/u);
    }
    writeFileSync(join(stateDirectory, 'local-owner-recovery', record.recoveryId + '.json'), '{"ciphertext":"tampered"}');
    expect(() => store.read(record.recoveryId, context)).toThrow(/Recovery operation denied/u);
  });
  it('refuses symlinked recovery directories', () => {
    const stateDirectory = directory();const outside = directory();
    symlinkSync(outside, join(stateDirectory, 'local-owner-recovery'));
    expect(() => new LocalRecoveryStore({ stateDirectory })).toThrow(/Recovery operation denied/u);
    expect(readdirSync(outside)).toEqual([]);
  });
  it('refuses a preexisting key symlink without modifying its target', () => {
    const stateDirectory = directory();const outside = directory();
    const original = Buffer.alloc(32, 7);writeFileSync(join(outside, 'key'), original, { mode: 0o600 });
    mkdirSync(join(stateDirectory, 'local-owner-recovery'), { mode: 0o700 });
    symlinkSync(join(outside, 'key'), join(stateDirectory, 'local-owner-recovery', 'recovery.key'));
    expect(() => new LocalRecoveryStore({ stateDirectory })).toThrow(/Recovery operation denied/u);
    expect(readFileSync(join(outside, 'key'))).toEqual(original);
  });
  it('keeps content versions stable across creation and inode changes while separating request fingerprints', () => {
    const store = new LocalRecoveryStore({ stateDirectory: directory() });const bytes = Buffer.from('fixture');
    expect(store.version(context, bytes)).toBe(store.version({ ...context, sourceIdentity: null, operation: 'copy' }, bytes));
    expect(store.version(context, bytes)).not.toBe(store.version({ ...context, path: 'other' }, bytes));
    expect(store.binding(context, bytes)).not.toBe(store.version(context, bytes));
    expect(store.pathFingerprint(context)).not.toBe(store.binding(context, bytes));
  });
});
