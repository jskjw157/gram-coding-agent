import type Database from 'better-sqlite3';

export interface LocalOperationAdmission {
  id: string; kind: 'READ' | 'MUTATION'; operation: string; rootId: string;
  rootIdentity: string; volumeKey: string; pathFingerprint: string; bindingDigest: string;
}
export type LocalOperationState = 'OBSERVING' | 'PREPARED' | 'APPLIED' | 'DENIED' | 'UNRESOLVED';
export interface LocalOperationRecord extends LocalOperationAdmission {
  state: LocalOperationState; recoveryId: string | null; resultJson: string | null; createdAt: string; updatedAt: string;
}
export interface LocalOperationResult {
  version?: string; previousVersion?: string | null; recoveryId?: string; bytes?: number;
  created?: boolean; moved?: boolean; restored?: boolean; sourceRemoved?: boolean;
}
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[47][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const operations = ['list', 'stat', 'read', 'search', 'binary-read', 'convert-path', 'reveal', 'write', 'patch', 'mkdir', 'move', 'copy', 'trash', 'restore', 'binary-write'];
const reads = ['list', 'stat', 'read', 'search', 'binary-read', 'convert-path', 'reveal'];
const fail = () => new Error('Local operation journal rejected the operation');
function validate(input: LocalOperationAdmission): void {
  const keys = ['id', 'kind', 'operation', 'rootId', 'rootIdentity', 'volumeKey', 'pathFingerprint', 'bindingDigest'];
  if (!input || Object.keys(input).length !== keys.length || Object.keys(input).some(k => !keys.includes(k)) ||
      !idPattern.test(input.id) || !['READ', 'MUTATION'].includes(input.kind) || !operations.includes(input.operation) ||
      (input.kind === 'READ') !== reads.includes(input.operation) || !/^[a-z][a-z0-9_-]{0,31}$/u.test(input.rootId) ||
      !/^\d+:\d+$/u.test(input.rootIdentity) || !/^(?:windows|linux):\d+$/u.test(input.volumeKey) ||
      !digestPattern.test(input.pathFingerprint) || !digestPattern.test(input.bindingDigest)) throw fail();
}
function resultJson(result: LocalOperationResult): string {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw fail();
  for (const [key, value] of Object.entries(result)) {
    if (key === 'version' || key === 'previousVersion') {
      if (key === 'previousVersion' && value === null) continue;
      if (typeof value !== 'string' || !digestPattern.test(value)) throw fail();
    } else if (key === 'recoveryId') {if (typeof value !== 'string' || !idPattern.test(value)) throw fail();}
    else if (key === 'bytes') {if (!Number.isSafeInteger(value) || Number(value) < 0) throw fail();}
    else if (['created', 'moved', 'restored', 'sourceRemoved'].includes(key)) {if (typeof value !== 'boolean') throw fail();}
    else throw fail();
  }
  return JSON.stringify(result);
}
const columns = `id, kind, operation, root_id AS rootId, root_identity AS rootIdentity,
  volume_key AS volumeKey, path_fingerprint AS pathFingerprint, binding_digest AS bindingDigest,
  state, recovery_id AS recoveryId, result_json AS resultJson, created_at AS createdAt, updated_at AS updatedAt`;

/** Dedicated metadata-only SQLite journal, not a migration of agent.sqlite.
 * An unresolved mutation permanently blocks overlapping roots on its volume
 * until a separately verified reconciliation exists. No TTL release exists. */
export class LocalOperationRepository {
  constructor(private readonly db: Database.Database) {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
    if (tables.some(row => !['local_workspace_operations', 'local_workspace_operation_events'].includes(row.name))) throw fail();
    db.exec(`
      CREATE TABLE IF NOT EXISTS local_workspace_operations (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('READ','MUTATION')),
        operation TEXT NOT NULL, root_id TEXT NOT NULL, root_identity TEXT NOT NULL,
        volume_key TEXT NOT NULL, path_fingerprint TEXT NOT NULL, binding_digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('OBSERVING','PREPARED','APPLIED','DENIED','UNRESOLVED')),
        recovery_id TEXT, result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS local_workspace_active_volume
        ON local_workspace_operations(volume_key)
        WHERE kind='MUTATION' AND state IN ('PREPARED','UNRESOLVED');
      CREATE TABLE IF NOT EXISTS local_workspace_operation_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL REFERENCES local_workspace_operations(id),
        state TEXT NOT NULL, created_at TEXT NOT NULL
      ) STRICT;
    `);
    const fields = db.prepare('PRAGMA table_info(local_workspace_operations)').all() as { name: string }[];
    if (!fields.some(field => field.name === 'recovery_id')) db.exec('ALTER TABLE local_workspace_operations ADD COLUMN recovery_id TEXT');
  }
  get(id: string): LocalOperationRecord | undefined {
    if (!idPattern.test(id)) throw fail();
    const record = this.db.prepare(`SELECT ${columns} FROM local_workspace_operations WHERE id=?`).get(id) as LocalOperationRecord | undefined;
    if (record !== undefined) {
      const { state, resultJson: result } = record;
      validate({ id: record.id, kind: record.kind, operation: record.operation, rootId: record.rootId,
        rootIdentity: record.rootIdentity, volumeKey: record.volumeKey,
        pathFingerprint: record.pathFingerprint, bindingDigest: record.bindingDigest });
      if (!['OBSERVING', 'PREPARED', 'APPLIED', 'DENIED', 'UNRESOLVED'].includes(state)) throw fail();
      if ((state === 'APPLIED' && result === null) || (['PREPARED', 'OBSERVING'].includes(state) && result !== null) ||
          (state === 'OBSERVING' && record.kind !== 'READ') || (['PREPARED', 'UNRESOLVED'].includes(state) && record.kind !== 'MUTATION')) throw fail();
      if (result !== null) resultJson(JSON.parse(result) as LocalOperationResult);
      if (record.recoveryId !== null && !idPattern.test(record.recoveryId)) throw fail();
    }
    return record;
  }
  admit(input: LocalOperationAdmission): { created: boolean; operation: LocalOperationRecord } {
    validate(input);
    return this.db.transaction(() => {
      const previous = this.get(input.id);
      if (previous !== undefined) {
        if (Object.entries(input).some(([key, value]) => previous[key as keyof LocalOperationRecord] !== value)) throw fail();
        return { created: false, operation: previous };
      }
      const now = new Date().toISOString();const state = input.kind === 'READ' ? 'OBSERVING' : 'PREPARED';
      this.db.prepare(`INSERT INTO local_workspace_operations
        (id,kind,operation,root_id,root_identity,volume_key,path_fingerprint,binding_digest,state,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(input.id, input.kind, input.operation, input.rootId, input.rootIdentity,
          input.volumeKey, input.pathFingerprint, input.bindingDigest, state, now, now);
      this.db.prepare('INSERT INTO local_workspace_operation_events(operation_id,state,created_at) VALUES (?,?,?)').run(input.id, state, now);
      const stored = this.get(input.id);if (stored === undefined) throw fail();
      return { created: true, operation: stored };
    }).immediate();
  }
  finish(id: string, state: 'APPLIED' | 'DENIED' | 'UNRESOLVED', result: LocalOperationResult): void {
    if (!['APPLIED', 'DENIED', 'UNRESOLVED'].includes(state)) throw fail();
    const json = resultJson(result);
    this.db.transaction(() => {
      const current = this.get(id);
      if (current === undefined || !['PREPARED', 'OBSERVING'].includes(current.state) ||
          (current.kind === 'READ' && state === 'UNRESOLVED')) throw fail();
      const now = new Date().toISOString();
      const changed = this.db.prepare('UPDATE local_workspace_operations SET state=?,result_json=?,updated_at=? WHERE id=? AND state=?')
        .run(state, json, now, id, current.state);
      if (changed.changes !== 1) throw fail();
      this.db.prepare('INSERT INTO local_workspace_operation_events(operation_id,state,created_at) VALUES (?,?,?)').run(id, state, now);
    }).immediate();
  }
  attachRecovery(id: string, recoveryId: string): void {
    if (!idPattern.test(id) || !idPattern.test(recoveryId)) throw fail();
    this.db.transaction(() => {
      const operation = this.get(id);
      if (operation?.kind !== 'MUTATION' || operation.state !== 'PREPARED' || operation.recoveryId !== null) throw fail();
      const now = new Date().toISOString();
      if (this.db.prepare("UPDATE local_workspace_operations SET recovery_id=?,updated_at=? WHERE id=? AND state='PREPARED' AND recovery_id IS NULL")
        .run(recoveryId, now, id).changes !== 1) throw fail();
      this.db.prepare('INSERT INTO local_workspace_operation_events(operation_id,state,created_at) VALUES (?,?,?)').run(id, 'RECOVERY_CAPTURED', now);
    }).immediate();
  }
  events(id: string): { state: LocalOperationState | 'RECOVERY_CAPTURED'; createdAt: string }[] {
    if (!idPattern.test(id)) throw fail();
    return this.db.prepare('SELECT state,created_at AS createdAt FROM local_workspace_operation_events WHERE operation_id=? ORDER BY id').all(id) as { state: LocalOperationState | 'RECOVERY_CAPTURED'; createdAt: string }[];
  }
}
