import type Database from 'better-sqlite3';
import type { TaskId } from '@gram/domain';

export const AUDIT_REDACTED = '***REDACTED***' as const;

const AUDIT_PAYLOAD_FIELD_ALLOWLIST: ReadonlySet<string> = new Set([
  'operationId',
  'taskId',
  'step',
  'revision',
  'requesterId',
  'clientRequestId',
  'status',
  'metadata',
  'digest',
  'receipt',
  'reason',
]);

const SECRET_KEY_PATTERN =
  /(password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|auth|credential|session[_-]?key)/i;
const BEARER_PATTERN = /(Authorization\s*:\s*Bearer\s+)[^\s]+/gi;
const TOKEN_PATTERN =
  /\b(?:sk-[A-Za-z0-9_-]{10,}|github_pat_[A-Za-z0-9_]{10,}|gh[opusr]_[A-Za-z0-9]{10,})\b/g;

export type SanitizedAuditScalar = string | number | boolean | null;
export interface SanitizedAuditObject {
  readonly [field: string]: SanitizedAuditValue;
}
export type SanitizedAuditValue =
  | SanitizedAuditScalar
  | readonly SanitizedAuditValue[]
  | SanitizedAuditObject;

function redactText(text: string): string {
  return text
    .replace(BEARER_PATTERN, `$1${AUDIT_REDACTED}`)
    .replace(TOKEN_PATTERN, AUDIT_REDACTED);
}

export function sanitizeAuditValue(value: unknown, seen?: WeakMap<object, unknown>): SanitizedAuditValue {
  const known = seen ?? new WeakMap<object, unknown>();
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) {
    if (known.has(value)) return '[Circular]';
    const result: SanitizedAuditValue[] = [];
    known.set(value, result);
    for (const item of value) result.push(sanitizeAuditValue(item, known));
    return result;
  }
  if (typeof value === 'object') {
    if (known.has(value)) return '[Circular]';
    const result: Record<string, SanitizedAuditValue> = {};
    known.set(value, result);
    for (const [key, item] of Object.entries(value)) {
      result[key] = SECRET_KEY_PATTERN.test(key)
        ? AUDIT_REDACTED
        : sanitizeAuditValue(item, known);
    }
    return result;
  }
  return null;
}

export function sanitizeAuditPayload(payload: unknown): SanitizedAuditObject {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { receipt: sanitizeAuditValue(payload) };
  }
  const sanitized: Record<string, SanitizedAuditValue> = {};
  for (const [key, item] of Object.entries(payload)) {
    if (!AUDIT_PAYLOAD_FIELD_ALLOWLIST.has(key)) continue;
    sanitized[key] = SECRET_KEY_PATTERN.test(key)
      ? AUDIT_REDACTED
      : sanitizeAuditValue(item);
  }
  return sanitized;
}

export interface AuditEventInput {
  taskId?: TaskId | null;
  eventType: string;
  payload?: SanitizedAuditValue;
  createdAt?: string;
}

export class AuditRepository {
  constructor(private readonly db: Database.Database) {}

  append(event: AuditEventInput): number {
    const payload =
      event.payload === undefined ? null : JSON.stringify(sanitizeAuditPayload(event.payload));
    const result = this.db
      .prepare(`
        INSERT INTO audit_events(task_id, event_type, payload_json, created_at)
        VALUES (?, ?, ?, ?)
      `)
      .run(
        event.taskId ?? null,
        event.eventType,
        payload,
        event.createdAt ?? new Date().toISOString(),
      );
    return Number(result.lastInsertRowid);
  }
}
