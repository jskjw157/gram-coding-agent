import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditRepository, openDatabase, runMigrations, TaskRepository } from '@gram/persistence';
import { TaskService } from './task-service.js';

const tempDirs: string[] = [];
const openDbs: Array<{ close(): void }> = [];

function openState() {
  const dir = mkdtempSync(join(tmpdir(), 'gram-task-engine-'));
  tempDirs.push(dir);
  const db = openDatabase(join(dir, 'state.db'));
  openDbs.push(db);
  runMigrations(db);
  return db;
}

afterEach(() => {
  while (openDbs.length) openDbs.pop()?.close();
  let dir: string | undefined;
  while ((dir = tempDirs.pop()) !== undefined) rmSync(dir, { recursive: true, force: true });
});

describe('TaskService.create', () => {
  it('creates a queued task with UUIDv7 identity and display sequence', async () => {
    const db = openState();
    const tasks = new TaskRepository(db);
    const service = new TaskService(tasks, new AuditRepository(db));

    const task = await service.create({
      repo: 'mamf-web',
      goal: 'Fix Excel download URL',
      publishMode: 'PULL_REQUEST',
    });

    expect(task.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(task.displayId).toBe('TASK-000001');
    expect(task.status).toBe('QUEUED');
    expect(task.repo).toBe('mamf-web');
    expect(task.publishMode).toBe('PULL_REQUEST');
    expect(tasks.get(task.id)?.repoSelector).toBe('mamf-web');
  });

  it('records a secret-minimized TASK_CREATED audit event', async () => {
    const db = openState();
    const service = new TaskService(new TaskRepository(db), new AuditRepository(db));
    const goal = 'Fix Excel download URL token=do-not-copy-to-audit';

    const task = await service.create({ repo: 'mamf-web', goal });
    const row = db
      .prepare('SELECT event_type AS eventType, payload_json AS payloadJson FROM audit_events WHERE task_id = ?')
      .get(task.id) as { eventType: string; payloadJson: string } | undefined;

    expect(row?.eventType).toBe('TASK_CREATED');
    expect(row?.payloadJson).toBeDefined();
    const payload = JSON.parse(row?.payloadJson ?? '{}') as Record<string, unknown>;
    expect(payload).toEqual({ repoSelector: 'mamf-web', publishMode: 'PULL_REQUEST', taskType: 'CODING' });
    expect(row?.payloadJson).not.toContain(goal);
  });
});
