import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../database.js';
import { runMigrations } from '../migrator.js';
import { AuditRepository } from './audit-repository.js';

const tempDirs: string[] = [];
const openDbs: Array<{ close(): void }> = [];

function openMigratedDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), 'gram-audit-'));
  tempDirs.push(dir);
  const db = openDatabase(join(dir, 'state.db'));
  openDbs.push(db);
  runMigrations(db);
  return db;
}

function lastPayload(db: Database.Database): Record<string, unknown> {
  const row = db
    .prepare('SELECT payload_json AS payload FROM audit_events ORDER BY id DESC LIMIT 1')
    .get() as { payload: string | null };
  expect(row).toBeDefined();
  expect(row.payload).not.toBeNull();
  return JSON.parse(row.payload as string) as Record<string, unknown>;
}

afterEach(() => {
  while (openDbs.length) openDbs.pop()?.close();
  let dir: string | undefined;
  while ((dir = tempDirs.pop()) !== undefined) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('AuditRepository sanitized schema (D11: allowlist fields + secret redaction)', () => {
  it('redacts secret values instead of passing raw unknown payloads through', () => {
    const db = openMigratedDb();
    const audit = new AuditRepository(db);
    audit.append({
      eventType: 'operation.created',
      payload: {
        operationId: 1,
        step: 'plan',
        metadata: {
          apiKey: 'sk-test-secret-value-0123456789',
          nested: { password: 'hunter2-secret' },
        },
        receipt: { note: 'Authorization: Bearer super-secret-token-abc' },
      },
    });
    const flat = JSON.stringify(lastPayload(db));
    expect(flat).not.toContain('sk-test-secret-value-0123456789');
    expect(flat).not.toContain('hunter2-secret');
    expect(flat).not.toContain('super-secret-token-abc');
    expect(flat).toContain('***REDACTED***');
  });

  it('strips non-allowlisted top-level fields from the stored payload', () => {
    const db = openMigratedDb();
    const audit = new AuditRepository(db);
    audit.append({
      eventType: 'operation.created',
      payload: {
        operationId: 7,
        step: 'plan',
        rawBody: { should: 'never persist' },
        raw_body: 'never persist',
      },
    });
    const payload = lastPayload(db);
    expect(payload['operationId']).toBe(7);
    expect(payload['step']).toBe('plan');
    const flat = JSON.stringify(payload).toLowerCase();
    expect(flat).not.toContain('rawbody');
    expect(flat).not.toContain('raw_body');
    expect(flat).not.toContain('never persist');
  });

  it('keeps canonical allowlisted operational values intact (no over-redaction)', () => {
    const db = openMigratedDb();
    const audit = new AuditRepository(db);
    audit.append({
      eventType: 'operation.created',
      payload: {
        operationId: 3,
        taskId: 'task-abc',
        step: 'audit-check',
        metadata: { lane: 'ops', attempt: 1 },
        digest: 'sha256:deadbeef',
        receipt: { status: 'ok', redactedFields: ['token'] },
      },
    });
    const payload = lastPayload(db);
    expect(payload['metadata']).toMatchObject({ lane: 'ops', attempt: 1 });
    expect(payload['digest']).toBe('sha256:deadbeef');
    expect(payload['receipt']).toMatchObject({ status: 'ok' });
  });
});
