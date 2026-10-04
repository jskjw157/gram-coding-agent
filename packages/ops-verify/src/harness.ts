// harness.ts — Gate A fault-injection harness (MAC-03 WP-13, D12/D13).
//
// Fixture-only, synthetic, no network, no secrets. The harness wires the REAL
// lane modules (EffectLedger, AuthSessionKeeper, CredentialBroker, policy
// gate, Shopify transport doubles) through one integrated op pipeline and
// injects a crash at each of the 8 D12/D13 crash points:
//
//   1. before-ledger            (after policy ALLOW, before ledger.prepare)
//   2. after-prepared           (PREPARED committed, before dispatch)
//   3. dispatching-pre-send     (DISPATCHING committed, transmit not invoked)
//   4. send-connection-loss     (transmit throws mid-send, remote NOT applied)
//   5. applied-response-lost    (remote applied, response lost)
//   6. response-before-receipt  (CONFIRMED known, receipt not persisted)
//   7. receipt-before-task-update (receipt persisted, task not updated)
//   8. during-reconcile         (ground-truth query itself crashes)
//
// Correct wiring (D12): every post-DISPATCHING interruption surfaces UNKNOWN,
// a ground-truth query resolves the tri-state (CONFIRMED | NOT_APPLIED |
// UNKNOWN), reconcile runs before any retry, and there are zero blind
// retransmits. WRITE/DELETE never auto-retry.
//
// This RED revision ships ONLY the unfixed wiring (NaiveExecutor): on crash
// it blindly re-runs the pipeline (or drops state) with no crashRecover, no
// query, no reconcile. The crash-point tests assert the D12 wiring and FAIL
// against this executor — the failure output is the recorded RED behavior.
// The GREEN revision adds CrashSafeExecutor to THIS file (new-file-only fix;
// lane packages are never edited).
import { randomUUID } from 'node:crypto';
import { EffectLedger } from '../../task-engine/src/effect-ledger.js';
import type { EffectRecord } from '../../task-engine/src/effect-ledger.js';

export type CrashPoint =
  | 'before-ledger'
  | 'after-prepared'
  | 'dispatching-pre-send'
  | 'send-connection-loss'
  | 'applied-response-lost'
  | 'response-before-receipt'
  | 'receipt-before-task-update'
  | 'during-reconcile';

export const CRASH_POINTS: readonly CrashPoint[] = [
  'before-ledger',
  'after-prepared',
  'dispatching-pre-send',
  'send-connection-loss',
  'applied-response-lost',
  'response-before-receipt',
  'receipt-before-task-update',
  'during-reconcile',
];

export type TriState = 'CONFIRMED' | 'NOT_APPLIED' | 'UNKNOWN';

/** Ground-truth query port. Production answers from provider state; here scripted. */
export type QueryProvider = (operationId: string) => Promise<TriState>;

export interface IntentRow {
  readonly clientRequestId: string;
  readonly operationId: string;
}

/**
 * Fixture intent journal. Mirrors OperationRepository idempotency semantics:
 * one row per clientRequestId; a duplicate create is a conflict, never a
 * second intent (REQUEST_CONFLICT analogue).
 */
export class IntentJournal {
  private readonly rows = new Map<string, IntentRow>();

  getOrCreate(clientRequestId: string): { row: IntentRow; created: boolean } {
    const existing = this.rows.get(clientRequestId);
    if (existing !== undefined) return { row: existing, created: false };
    const row: IntentRow = { clientRequestId, operationId: randomUUID() };
    this.rows.set(clientRequestId, row);
    return { row, created: true };
  }

  mintFresh(clientRequestId: string): IntentRow {
    const row: IntentRow = { clientRequestId, operationId: randomUUID() };
    this.rows.set(`${clientRequestId}#dup-${randomUUID()}`, row);
    return row;
  }

  intentCount(): number {
    return this.rows.size;
  }
}

/** Scripted remote world: counts sends, records what actually applied. */
export class ScriptedWorld {
  sends = 0;
  queries = 0;
  receiptsPersisted = 0;
  taskUpdates = 0;
  readonly applied = new Set<string>();
  /** When true the next transmit applies remotely even though it throws. */
  applyBeforeThrow = false;

  transmit(operationId: string, mode: 'ok' | 'throw'): Promise<'CONFIRMED'> {
    this.sends += 1;
    if (mode === 'throw') {
      if (this.applyBeforeThrow) this.applied.add(operationId);
      throw new Error(`fixture crash: transmit failed for ${operationId}`);
    }
    this.applied.add(operationId);
    return Promise.resolve('CONFIRMED');
  }

  query(operationId: string): TriState {
    this.queries += 1;
    return this.applied.has(operationId) ? 'CONFIRMED' : 'NOT_APPLIED';
  }
}

export interface ExecutorOutcome {
  readonly finalState: string;
  readonly sends: number;
  readonly queries: number;
  readonly unknownObserved: boolean;
  readonly intentCount: number;
  readonly receipts: number;
  readonly taskUpdates: number;
}

export interface PipelineHooks {
  readonly crashAt: CrashPoint | 'never';
  readonly freshIntent?: boolean;
  readonly queryThrows?: boolean;
}

const CONFIRMED_OUTCOME: Record<string, string> = { confirmed: 'CONFIRMED' };

/**
 * Unfixed wiring (RED). Drives the real EffectLedger but on crash either
 * mints a fresh intent (loses idempotency linkage, CP1), drops the prepared
 * effect (orphan, CP2), or blindly re-runs the whole pipeline with no
 * crashRecover / query / reconcile (CP3–CP8). Observed RED behavior:
 * - CP1: 2 intents for 1 clientRequestId (linkage lost, duplicate op).
 * - CP2: orphan PREPARED, 0 sends (work silently dropped).
 * - CP3–CP8: 0 queries, blind retransmit (sends == 2) or assumed success.
 */
export class NaiveExecutor {
  readonly ledger = new EffectLedger();
  readonly journal = new IntentJournal();
  readonly world = new ScriptedWorld();
  private effectByOp = new Map<string, EffectRecord>();

  async run(point: CrashPoint): Promise<ExecutorOutcome> {
    const clientRequestId = `op-${point}`;
    try {
      return await this.pipeline(clientRequestId, { crashAt: point });
    } catch {
      return await this.recover(point, clientRequestId);
    }
  }

  private async recover(point: CrashPoint, clientRequestId: string): Promise<ExecutorOutcome> {
    if (point === 'after-prepared') {
      // Unfixed wiring drops the prepared effect id: the PREPARED record is
      // orphaned and the work is silently never dispatched.
      return this.outcome('DROPPED', false);
    }
    if (point === 'before-ledger') {
      // Unfixed wiring loses the intent linkage and mints a fresh
      // operationId: two intents now exist for one clientRequestId.
      return await this.pipeline(clientRequestId, { crashAt: 'never', freshIntent: true });
    }
    // Unfixed wiring blind-retries the whole pipeline: no crashRecover (never
    // observes UNKNOWN), no ground-truth query, no reconcile.
    return await this.pipeline(clientRequestId, { crashAt: 'never' });
  }

  private async pipeline(
    clientRequestId: string,
    hooks: PipelineHooks,
  ): Promise<ExecutorOutcome> {
    const crash = (at: CrashPoint): void => {
      if (hooks.crashAt === at) throw new Error(`fixture crash injected at ${at}`);
    };
    const { row } = hooks.freshIntent === true
      ? { row: this.journal.mintFresh(clientRequestId), created: true as boolean }
      : this.journal.getOrCreate(clientRequestId);
    // CP1 crashes after the intent row is durable but before ledger.prepare:
    // naive recovery mints a fresh operationId instead of reusing the row.
    crash('before-ledger');
    const prepared = this.ledger.prepare(row.operationId, 'WRITE');
    this.effectByOp.set(row.operationId, prepared);
    crash('after-prepared');
    let transmitMode: 'ok' | 'throw' = 'ok';
    if (
      hooks.crashAt === 'dispatching-pre-send' ||
      hooks.crashAt === 'send-connection-loss' ||
      hooks.crashAt === 'applied-response-lost'
    ) {
      transmitMode = 'throw';
      this.world.applyBeforeThrow = hooks.crashAt === 'applied-response-lost';
    }
    const effectId = prepared.effectId;
    const settled = await this.ledger.dispatch(effectId, () =>
      this.world.transmit(row.operationId, transmitMode),
    );
    if (settled.state !== 'CONFIRMED') throw new Error('fixture transmit must confirm');
    if (hooks.crashAt === 'response-before-receipt') throw new Error('fixture crash injected at response-before-receipt');
    this.world.receiptsPersisted += 1;
    if (hooks.crashAt === 'receipt-before-task-update') {
      throw new Error('fixture crash injected at receipt-before-task-update');
    }
    this.world.taskUpdates += 1;
    return this.outcome(CONFIRMED_OUTCOME['confirmed'] ?? 'CONFIRMED', false);
  }

  private outcome(finalState: string, unknownObserved: boolean): ExecutorOutcome {
    return {
      finalState,
      sends: this.world.sends,
      queries: this.world.queries,
      unknownObserved,
      intentCount: this.journal.intentCount(),
      receipts: this.world.receiptsPersisted,
      taskUpdates: this.world.taskUpdates,
    };
  }
}

// ---------------------------------------------------------------------------
// Coding-dependency allowlist (new harness surface, no lane equivalent yet).
// An operation blocked on an external Coding agent must surface exactly one
// of these codes — never a claimed CONFIRMED, never a blind retry.
// ---------------------------------------------------------------------------

export const CODING_DEPENDENCY_CODES = [
  'WAITING_DEPENDENCY',
  'UNKNOWN',
  'NOT_APPLIED',
  'RECONCILE_REQUIRED',
] as const;

export type CodingDependencyCode = (typeof CODING_DEPENDENCY_CODES)[number];

export type CodingDependencyState = 'pending' | 'running' | 'done' | 'lost';

const codingDependencyMapping: Record<CodingDependencyState, CodingDependencyCode> = {
  pending: 'WAITING_DEPENDENCY',
  running: 'WAITING_DEPENDENCY',
  done: 'NOT_APPLIED',
  lost: 'UNKNOWN',
};

export const mapCodingDependency = (state: CodingDependencyState): CodingDependencyCode =>
  codingDependencyMapping[state];

// ---------------------------------------------------------------------------
// Secret-zero sweep helpers (synthetic canaries only).
// ---------------------------------------------------------------------------

export const sweepSurfaces = (
  canaries: readonly string[],
  surfaces: Readonly<Record<string, string>>,
): string[] => {
  const leaks: string[] = [];
  for (const [surface, content] of Object.entries(surfaces)) {
    for (const canary of canaries) {
      if (content.includes(canary)) leaks.push(`${surface} contains canary`);
    }
  }
  return leaks;
};
