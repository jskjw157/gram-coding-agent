import type Database from 'better-sqlite3';
import type { TaskId } from '@gram/domain';

export interface AuditEventInput {
  taskId?: TaskId | null;
  eventType: string;
  payload?: unknown;
  createdAt?: string;
}

export class AuditRepository {
  constructor(private readonly db: Database.Database) {}

  append(event: AuditEventInput): number {
    const result = this.db
      .prepare(`
        INSERT INTO audit_events(task_id, event_type, payload_json, created_at)
        VALUES (?, ?, ?, ?)
      `)
      .run(
        event.taskId ?? null,
        event.eventType,
        event.payload === undefined ? null : JSON.stringify(event.payload),
        event.createdAt ?? new Date().toISOString(),
      );
    return Number(result.lastInsertRowid);
  }
}
