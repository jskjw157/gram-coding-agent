import { createHash } from 'node:crypto';
import type { PolicyDecisionKind } from '@gram/domain';

/**
 * Central Policy Engine extension for Operations (MAC-03 WP-09, decisions D7/D11).
 *
 * The central engine ONLY decides risk from the canonical typed action plus
 * effect metadata. Adapters never self-downgrade: any caller-claimed risk is
 * accepted structurally but ignored for the verdict.
 *
 * Structural OperationIntent mirrors the domain contracts identity fields so
 * this package needs no new dependency (imports @gram/domain types only).
 */
export type OperationRisk = 'READ' | 'REMOTE_WRITE' | 'HIGH_RISK' | 'DENY';

export type OperationEffectClass = 'READ' | 'WRITE' | 'DELETE';

export type OperationScope = 'RESOURCE' | 'STORE' | 'ACCOUNT';

export interface OperationIntentLike {
  readonly taskId: string;
  readonly operationId: string;
  readonly canonicalAction: string;
  readonly storeId: string;
  readonly accountId: string;
  readonly targetResource: string;
  readonly parameterDigest: string;
  readonly effectClass: OperationEffectClass;
  readonly expectedState: string;
  readonly expectedVersion: string;
  readonly providerId: string;
  readonly recipeId: string;
}

export interface OperationMetadata {
  readonly executionMode?: string;
  readonly taskKind?: string;
  readonly scope?: OperationScope;
}

/** Caller-claimed hint. Accepted structurally, ignored for the verdict (D7/D11). */
export interface ClassificationHint {
  readonly claimedRisk?: OperationRisk;
}

export interface ClassifiedOperation {
  readonly verdict: OperationRisk;
  readonly ruleId: string;
  readonly reason: string;
  readonly operationHash: string;
}

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED' | 'CONSUMED';

export interface OperationApprovalInput {
  readonly id: string;
  readonly taskId: string;
  readonly operationHash: string;
  readonly status: ApprovalStatus;
  readonly expiresAt: number;
}

export interface ApprovalCheck {
  readonly accepted: boolean;
  readonly reason: string;
  readonly operationHash: string;
}

export interface OperationDecision {
  readonly kind: PolicyDecisionKind;
  readonly ruleId: string;
  readonly reason: string;
  readonly operationHash: string;
}

const identityFields = [
  'taskId',
  'operationId',
  'canonicalAction',
  'storeId',
  'accountId',
  'targetResource',
  'parameterDigest',
  'effectClass',
  'expectedState',
  'expectedVersion',
  'providerId',
  'recipeId',
] as const satisfies readonly (keyof OperationIntentLike)[];

/** Duplicates the domain operationHash algorithm (ordered identity JSON, sha256). */
export function hashOperationIntent(intent: OperationIntentLike): string {
  const ordered: Record<string, string> = {};
  for (const field of identityFields) {
    ordered[field] = intent[field];
  }
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

const READ_ACTIONS: readonly string[] = ['shopify.product.read', 'shopify.order.read'];
const REMOTE_WRITE_ACTIONS: readonly string[] = ['shopify.product.create', 'shopify.inventory.adjust'];
const HIGH_RISK_ACTIONS: readonly string[] = ['shopify.order.cancel', 'shopify.refund.create'];
const ACCOUNT_STORE_DELETE_PATTERN = /(^|\.)(account|store)\.delete($|[.-])/u;

function baseVerdict(intent: OperationIntentLike, metadata: OperationMetadata): ClassifiedOperation {
  const operationHash = hashOperationIntent(intent);
  const { canonicalAction, effectClass } = intent;

  if (ACCOUNT_STORE_DELETE_PATTERN.test(canonicalAction)) {
    return {
      verdict: 'DENY',
      ruleId: 'POL-OPS-ACCOUNT-STORE-DELETE',
      reason: `destructive account/store action ${canonicalAction} is forbidden`,
      operationHash,
    };
  }
  if (effectClass === 'DELETE' && (metadata.scope === 'ACCOUNT' || metadata.scope === 'STORE')) {
    return {
      verdict: 'DENY',
      ruleId: 'POL-OPS-SCOPE-DELETE',
      reason: `DELETE effect against ${metadata.scope} scope is forbidden`,
      operationHash,
    };
  }
  if (READ_ACTIONS.includes(canonicalAction)) {
    if (effectClass !== 'READ') {
      return {
        verdict: 'REMOTE_WRITE',
        ruleId: 'POL-OPS-READ-EFFECT-MISMATCH',
        reason: `read action ${canonicalAction} carries non-read effect and is treated as remote write`,
        operationHash,
      };
    }
    return {
      verdict: 'READ',
      ruleId: 'POL-OPS-READ',
      reason: `read-only action ${canonicalAction} is allowed`,
      operationHash,
    };
  }
  if (REMOTE_WRITE_ACTIONS.includes(canonicalAction)) {
    if (effectClass === 'DELETE') {
      return {
        verdict: 'HIGH_RISK',
        ruleId: 'POL-OPS-WRITE-EFFECT-ESCALATION',
        reason: `remote-write action ${canonicalAction} carries delete effect and is escalated`,
        operationHash,
      };
    }
    return {
      verdict: 'REMOTE_WRITE',
      ruleId: 'POL-OPS-REMOTE-WRITE',
      reason: `remote-write action ${canonicalAction} requires approval`,
      operationHash,
    };
  }
  if (HIGH_RISK_ACTIONS.includes(canonicalAction)) {
    return {
      verdict: 'HIGH_RISK',
      ruleId: 'POL-OPS-HIGH-RISK',
      reason: `high-risk action ${canonicalAction} requires approval`,
      operationHash,
    };
  }
  return {
    verdict: 'DENY',
    ruleId: 'POL-OPS-UNKNOWN-ACTION',
    reason: `unknown canonical action ${canonicalAction} is denied by default`,
    operationHash,
  };
}

/**
 * Central classification. The hint's claimedRisk is never consulted for the
 * verdict — the adapter cannot downgrade its own risk (D7/D11).
 */
export function classifyOperation(
  intent: OperationIntentLike,
  metadata: OperationMetadata,
  _hint?: ClassificationHint,
): ClassifiedOperation {
  // Claimed risk is deliberately never read: the central engine decides.
  void _hint;
  return baseVerdict(intent, metadata);
}

function checkApprovalFields(
  approval: OperationApprovalInput,
  intent: OperationIntentLike,
  now: number,
): ApprovalCheck {
  const operationHash = hashOperationIntent(intent);
  if (approval.taskId !== intent.taskId) {
    return {
      accepted: false,
      reason: `approval task ${approval.taskId} does not match operation task ${intent.taskId}; cross-task replay rejected`,
      operationHash,
    };
  }
  if (now > approval.expiresAt) {
    return {
      accepted: false,
      reason: 'approval expired; re-approval required',
      operationHash,
    };
  }
  if (approval.operationHash !== operationHash) {
    return {
      accepted: false,
      reason: 'operation identity changed; re-approval required',
      operationHash,
    };
  }
  if (approval.status !== 'APPROVED') {
    return {
      accepted: false,
      reason: `approval status ${approval.status} cannot authorize execution; APPROVED status required`,
      operationHash,
    };
  }
  return { accepted: true, reason: 'approval verified against full operation identity', operationHash };
}

/**
 * Durable single-use consume ledger for the approval gate.
 *
 * CANONICAL SOURCE (thin vendor, byte-faithful on the consume path):
 * packages/persistence/src/repositories/approval-repository.ts at
 * origin/feat/ops-common-approvals de3faf9a7d01d6fa0f1b6286cfa1da8304651f03
 * (`ApprovalRepository.consume`: conditional
 * `UPDATE approvals SET status = 'CONSUMED' ... WHERE status = 'APPROVED'`
 * with `changes === 1` deciding the winner, plus the lazy TTL expiry sweep
 * of APPROVED rows and the live-pair (`task_id`, `operation_hash`)
 * uniqueness from `request`). Vendored here because `@gram/policy` cannot
 * take a better-sqlite3-backed `@gram/persistence` dependency in this lane;
 * the follow-up is `import { ApprovalRepository } from
 * '../../persistence/src/repositories/approval-repository.js'` (relative path
 * per monorepo layout) once that file lands verbatim in this lane, at which
 * point this thin copy is deleted and the gate takes the real class directly
 * (it already speaks `ApprovalConsumptionPort`, the exact `consume` shape).
 * The schema omits only the tasks/policy_decisions FOREIGN KEYs (ledger
 * tests seed approvals directly); every column, CHECK, and index matches 004.
 */

/** Structural mirror of `ApprovalRepository.consume(taskId, operationHash)`. */
export interface ApprovalConsumptionPort {
  consume(taskId: string, operationHash: string): boolean;
}

export interface PersistentApprovalStatement {
  run(
    ...params: readonly unknown[]
  ): { readonly changes: number | bigint; readonly lastInsertRowid: number | bigint };
  get(...params: readonly unknown[]): unknown;
}

/** Minimal structural surface of the better-sqlite3 Database we consume. */
export interface PersistentApprovalDb {
  exec(sql: string): unknown;
  prepare(sql: string): PersistentApprovalStatement;
  transaction<T>(fn: () => T): { immediate(): T };
  close(): void;
}

export interface StoredOperationApproval {
  readonly id: number;
  readonly taskId: string;
  readonly operationHash: string;
  readonly status: ApprovalStatus;
  readonly requestedAt: string;
  readonly approvedAt: string | null;
  readonly consumedAt: string | null;
  readonly expiresAt: string | null;
}

interface ApprovalLedgerRow {
  readonly id: number;
  readonly task_id: string;
  readonly policy_decision_id: number | null;
  readonly operation_hash: string;
  readonly status: string;
  readonly requested_at: string;
  readonly approved_at: string | null;
  readonly consumed_at: string | null;
  readonly expires_at: string | null;
}

function decodeApprovalRow(row: ApprovalLedgerRow): StoredOperationApproval {
  if (
    row.status !== 'PENDING' &&
    row.status !== 'APPROVED' &&
    row.status !== 'CONSUMED' &&
    row.status !== 'DENIED' &&
    row.status !== 'EXPIRED'
  ) {
    throw new Error(`Approval row ${String(row.id)} has invalid status ${row.status}`);
  }
  if (row.operation_hash.length === 0) {
    throw new Error(`Approval row ${String(row.id)} is missing operation_hash`);
  }
  return {
    id: row.id,
    taskId: row.task_id,
    operationHash: row.operation_hash,
    status: row.status as ApprovalStatus,
    requestedAt: row.requested_at,
    approvedAt: row.approved_at,
    consumedAt: row.consumed_at,
    expiresAt: row.expires_at,
  };
}

/** Same TTL as the canonical repository: approvals expire 30 minutes after approval. */
export const APPROVAL_TTL_MS = 30 * 60 * 1000;

/** Idempotent ledger setup (mirrors 004 columns + live-pair index, minus FKs). Safe to run on reopen. */
export function ensureApprovalLedgerSchema(db: PersistentApprovalDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      policy_decision_id INTEGER,
      operation_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'CONSUMED', 'DENIED', 'EXPIRED')),
      requested_at TEXT NOT NULL,
      approved_at TEXT,
      consumed_at TEXT,
      expires_at TEXT
    ) STRICT;
  `);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS approvals_live_pair_idx
      ON approvals(task_id, operation_hash)
      WHERE status IN ('PENDING', 'APPROVED');
  `);
}

/**
 * Thin durable port of the canonical `ApprovalRepository` request/approve/
 * consume surface. `consume` is the exact conditional-UPDATE winner protocol,
 * so single-use holds across processes sharing one file.
 */
export class PersistentOperationApprovalStore implements ApprovalConsumptionPort {
  constructor(private readonly db: PersistentApprovalDb) {}

  get(id: number): StoredOperationApproval | undefined {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as
      | ApprovalLedgerRow
      | undefined;
    return row === undefined ? undefined : decodeApprovalRow(row);
  }

  request(taskId: string, operationHash: string): StoredOperationApproval {
    if (operationHash.length === 0) {
      throw new Error('operationHash must not be empty');
    }
    const apply = this.db.transaction((): StoredOperationApproval => {
      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE approvals
           SET status = 'EXPIRED'
           WHERE task_id = ? AND operation_hash = ? AND status = 'APPROVED' AND expires_at <= ?`,
        )
        .run(taskId, operationHash, now);
      const live = this.db
        .prepare(
          `SELECT * FROM approvals
           WHERE task_id = ? AND operation_hash = ? AND status IN ('PENDING', 'APPROVED')
           ORDER BY id DESC LIMIT 1`,
        )
        .get(taskId, operationHash) as ApprovalLedgerRow | undefined;
      if (live !== undefined) {
        return decodeApprovalRow(live);
      }
      const result = this.db
        .prepare(
          `INSERT INTO approvals(task_id, policy_decision_id, operation_hash, status, requested_at)
           VALUES (?, ?, ?, 'PENDING', ?)`,
        )
        .run(taskId, null, operationHash, now);
      const created = this.get(Number(result.lastInsertRowid));
      if (created === undefined) throw new Error('Approval row was not persisted');
      return created;
    });
    return apply.immediate();
  }

  approve(id: number, expectedOperationHash: string): StoredOperationApproval {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as
      | ApprovalLedgerRow
      | undefined;
    if (row === undefined) throw new Error(`Approval ${String(id)} was not found`);
    if (row.operation_hash !== expectedOperationHash) {
      throw new Error(`Approval ${String(id)} operation hash does not match`);
    }
    if (row.status !== 'PENDING') {
      throw new Error(`Approval ${String(id)} is already resolved with status ${row.status}`);
    }
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
    const result = this.db
      .prepare(
        `UPDATE approvals
         SET status = 'APPROVED', approved_at = ?, expires_at = ?
         WHERE id = ? AND status = 'PENDING'`,
      )
      .run(now, expiresAt, id);
    if (Number(result.changes) !== 1) {
      const current = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as
        | ApprovalLedgerRow
        | undefined;
      throw new Error(
        `Approval ${String(id)} is already resolved with status ${current?.status ?? 'UNKNOWN'}`,
      );
    }
    const stored = this.get(id);
    if (stored === undefined) throw new Error(`Approval ${String(id)} was not persisted`);
    return stored;
  }

  consume(taskId: string, operationHash: string): boolean {
    const attempt = this.db.transaction((): boolean => {
      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE approvals
           SET status = 'EXPIRED'
           WHERE task_id = ? AND operation_hash = ? AND status = 'APPROVED' AND expires_at <= ?`,
        )
        .run(taskId, operationHash, now);
      const result = this.db
        .prepare(
          `UPDATE approvals
           SET status = 'CONSUMED', consumed_at = ?
           WHERE task_id = ? AND operation_hash = ? AND status = 'APPROVED' AND expires_at > ?`,
        )
        .run(now, taskId, operationHash, now);
      return Number(result.changes) === 1;
    });
    return attempt.immediate();
  }
}

/**
 * Single-use, expiring, task-bound approval gate. Fail-closed on every path:
 * non-APPROVED, expired, cross-task, or hash-tampered approvals are rejected,
 * and a verified approval is consumed atomically through the durable ledger
 * port, so a NEW repository handle on the same file still sees CONSUMED:
 * restarts cannot replay.
 */
export class OperationPolicyGate {
  private readonly store: ApprovalConsumptionPort;
  private readonly clock: () => number;

  constructor(options: { readonly clock?: () => number; readonly store: ApprovalConsumptionPort }) {
    this.clock = options.clock ?? Date.now;
    this.store = options.store;
  }

  verify(approval: OperationApprovalInput, intent: OperationIntentLike): ApprovalCheck {
    const operationHash = hashOperationIntent(intent);
    const fields = checkApprovalFields(approval, intent, this.clock());
    if (!fields.accepted) {
      return fields;
    }
    if (!this.store.consume(approval.taskId, operationHash)) {
      return {
        accepted: false,
        reason: `approval ${approval.id} already consumed; single-use replay rejected, re-approval required`,
        operationHash,
      };
    }
    return { accepted: true, reason: 'approval verified against full operation identity', operationHash };
  }
}

/**
 * Final decision. DENY is non-promotable: a valid approval never lifts it —
 * only a policy change can, so the denial names that path.
 */
export function decideOperation(
  intent: OperationIntentLike,
  metadata: OperationMetadata,
  approval?: OperationApprovalInput,
  options: { readonly now?: number; readonly store?: ApprovalConsumptionPort } = {},
): OperationDecision {
  const classified = classifyOperation(intent, metadata);
  if (classified.verdict === 'DENY') {
    return {
      kind: 'DENY',
      ruleId: classified.ruleId,
      reason: `${classified.reason}; approval cannot lift DENY, request a policy change`,
      operationHash: classified.operationHash,
    };
  }
  if (classified.verdict === 'READ') {
    return {
      kind: 'ALLOW',
      ruleId: classified.ruleId,
      reason: classified.reason,
      operationHash: classified.operationHash,
    };
  }
  if (approval === undefined) {
    return {
      kind: 'NEEDS_APPROVAL',
      ruleId: classified.ruleId,
      reason: classified.reason,
      operationHash: classified.operationHash,
    };
  }
  const check = checkApprovalFields(approval, intent, options.now ?? Date.now());
  if (!check.accepted) {
    return {
      kind: 'NEEDS_APPROVAL',
      ruleId: classified.ruleId,
      reason: `${classified.reason}; ${check.reason}`,
      operationHash: classified.operationHash,
    };
  }
  if (options.store !== undefined) {
    if (!options.store.consume(approval.taskId, classified.operationHash)) {
      return {
        kind: 'NEEDS_APPROVAL',
        ruleId: classified.ruleId,
        reason: `${classified.reason}; approval ${approval.id} already consumed; single-use replay rejected, re-approval required`,
        operationHash: classified.operationHash,
      };
    }
  }
  return {
    kind: 'ALLOW',
    ruleId: classified.ruleId,
    reason: `approved ${classified.verdict.toLowerCase().replace('_', '-')} operation`,
    operationHash: classified.operationHash,
  };
}
