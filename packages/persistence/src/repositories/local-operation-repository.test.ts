import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../database.js';
import { runMigrations } from '../migrator.js';
import { LocalOperationRepository } from './local-operation-repository.js';

const databases: ReturnType<typeof openDatabase>[] = [];
function database() {const db = openDatabase(':memory:');databases.push(db);return db;}
afterEach(() => {for (const db of databases.splice(0)) db.close();});
const input = { id: '11111111-1111-4111-8111-111111111111', kind: 'MUTATION' as const,
  operation: 'write', rootId: 'windows-c', rootIdentity: '1:2', volumeKey: 'windows:1',
  pathFingerprint: 'a'.repeat(64), bindingDigest: 'b'.repeat(64) };
describe('durable metadata-only owner operation journal', () => {
  it('durably links a private recovery handle before effects and retains it across unknown outcomes and restart', () => {
    const db = database();const journal = new LocalOperationRepository(db);journal.admit(input);
    const recoveryId = '22222222-2222-4222-8222-222222222222';
    journal.attachRecovery(input.id, recoveryId);
    expect(new LocalOperationRepository(db).get(input.id)?.recoveryId).toBe(recoveryId);
    expect(() => journal.attachRecovery(input.id, '33333333-3333-4333-8333-333333333333')).toThrow();
    journal.finish(input.id, 'UNRESOLVED', {});
    expect(new LocalOperationRepository(db).get(input.id)).toMatchObject({ state: 'UNRESOLVED', recoveryId });
    expect(journal.events(input.id).map(event => event.state)).toEqual(['PREPARED', 'RECOVERY_CAPTURED', 'UNRESOLVED']);
  });
  it('records one real outcome and returns duplicate receipts without re-admission', () => {
    const db = database();const journal = new LocalOperationRepository(db);
    expect(journal.admit(input).created).toBe(true);
    journal.finish(input.id, 'APPLIED', { version: 'c'.repeat(64), bytes: 12 });
    const restarted = new LocalOperationRepository(db);
    expect(restarted.admit(input)).toMatchObject({ created: false, operation: { state: 'APPLIED' } });
    expect(restarted.events(input.id).map(event => event.state)).toEqual(['PREPARED', 'APPLIED']);
    expect(() => restarted.admit({ ...input, bindingDigest: 'd'.repeat(64) })).toThrow();
  });
  it('keeps unresolved writes quarantined across roots on the same volume without blocking reads or another volume', () => {
    const db = database();const journal = new LocalOperationRepository(db);
    journal.admit(input);journal.finish(input.id, 'UNRESOLVED', {});
    const restarted = new LocalOperationRepository(db);
    expect(() => restarted.admit({ ...input, id: '22222222-2222-4222-8222-222222222222', rootId: 'overlapping-root' })).toThrow();
    expect(restarted.admit({ ...input, id: '33333333-3333-4333-8333-333333333333', kind: 'READ', operation: 'read' }).created).toBe(true);
    expect(restarted.admit({ ...input, id: '44444444-4444-4444-8444-444444444444', volumeKey: 'windows:2' }).created).toBe(true);
    expect(() => restarted.finish(input.id, 'DENIED', {})).toThrow();
    expect(restarted.get(input.id)?.state).toBe('UNRESOLVED');
  });
  it('rejects content and arbitrary fields before persisting result metadata', () => {
    const db = database();const journal = new LocalOperationRepository(db);journal.admit(input);
    expect(() => journal.finish(input.id, 'APPLIED', { content: 'private-fixture' } as never)).toThrow();
    expect(journal.get(input.id)?.state).toBe('PREPARED');
    expect(JSON.stringify(db.prepare('SELECT * FROM local_workspace_operations').all())).not.toContain('private-fixture');
  });
  it('refuses the existing agent database without adding or modifying tables', () => {
    const db = database();runMigrations(db);
    const before = db.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all();
    expect(() => new LocalOperationRepository(db)).toThrow();
    expect(db.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all()).toEqual(before);
  });
  it('rolls back state and audit together if event persistence fails', () => {
    const db = database();const journal = new LocalOperationRepository(db);journal.admit(input);
    db.exec("CREATE TRIGGER fail_operation_event BEFORE INSERT ON local_workspace_operation_events BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;");
    expect(() => journal.finish(input.id, 'APPLIED', {})).toThrow();
    expect(journal.get(input.id)?.state).toBe('PREPARED');
    expect(journal.events(input.id)).toHaveLength(1);
  });
});
