import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PersistentOperationApprovalStore,
  OperationPolicyGate,
  classifyOperation,
  decideOperation,
  ensureApprovalLedgerSchema,
  hashOperationIntent,
  type OperationApprovalInput,
  type OperationIntentLike,
  type OperationMetadata,
  type PersistentApprovalDb,
  type StoredOperationApproval,
} from './operation-policy.js';

// better-sqlite3 is a dependency of @gram/persistence, not @gram/policy, and
// this lane must not add cross-package files: resolve the REAL driver through
// the persistence package's node_modules (test-only scaffolding; production
// code stays driver-agnostic behind PersistentApprovalDb). Verified with tsc:
// no static cross-package import, only a stringly resolve + structural cast.
const policyRequire = createRequire(import.meta.url);
const sqliteEntry: string = policyRequire.resolve('better-sqlite3', {
  paths: [fileURLToPath(new URL('../../persistence/src/', import.meta.url))],
});
const openLedgerDb = policyRequire(sqliteEntry) as new (
  filename: string,
  options?: { readonly timeout?: number },
) => PersistentApprovalDb;

const openDatabases: PersistentApprovalDb[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function trackDb(db: PersistentApprovalDb): PersistentApprovalDb {
  openDatabases.push(db);
  return db;
}

function releaseDb(db: PersistentApprovalDb): void {
  const index = openDatabases.indexOf(db);
  if (index !== -1) openDatabases.splice(index, 1);
  db.close();
}

/** Fresh isolated durable ledger on :memory: (same SQL, same winner protocol). */
function setupMemoryLedger(): PersistentOperationApprovalStore {
  const db = trackDb(new openLedgerDb(':memory:'));
  ensureApprovalLedgerSchema(db);
  return new PersistentOperationApprovalStore(db);
}

function approvalInputFor(row: StoredOperationApproval): OperationApprovalInput {
  if (row.status !== 'APPROVED' || row.expiresAt === null) {
    throw new Error('test setup: expected an APPROVED ledger row with expiry');
  }
  return {
    id: String(row.id),
    taskId: row.taskId,
    operationHash: row.operationHash,
    status: 'APPROVED',
    expiresAt: Date.parse(row.expiresAt),
  };
}

/** Request + approve through the REAL ledger path, mapped to gate input. */
function ledgerApproval(
  store: PersistentOperationApprovalStore,
  intent: OperationIntentLike,
): OperationApprovalInput {
  const requested = store.request(intent.taskId, hashOperationIntent(intent));
  return approvalInputFor(store.approve(requested.id, hashOperationIntent(intent)));
}

const baseIntent = (overrides: Partial<OperationIntentLike> = {}): OperationIntentLike => ({
  taskId: 'task-1',
  operationId: 'op-1',
  canonicalAction: 'shopify.product.read',
  storeId: 'store-1',
  accountId: 'acct-1',
  targetResource: 'product/1',
  parameterDigest: 'params-digest-1',
  effectClass: 'READ',
  expectedState: 'state-1',
  expectedVersion: 'v1',
  providerId: 'shopify',
  recipeId: 'recipe-1',
  ...overrides,
});

const meta = (overrides: Partial<OperationMetadata> = {}): OperationMetadata => ({
  executionMode: 'WRITE_APPROVED',
  taskKind: 'COMMAND',
  scope: 'RESOURCE',
  ...overrides,
});

const approvalFor = (intent: OperationIntentLike, overrides: Record<string, unknown> = {}) => ({
  id: 'approval-1',
  taskId: intent.taskId,
  operationHash: hashOperationIntent(intent),
  status: 'APPROVED' as const,
  expiresAt: Date.now() + 60_000,
  ...overrides,
});

const gateWithLedger = (): {
  gate: OperationPolicyGate;
  store: PersistentOperationApprovalStore;
} => {
  const store = setupMemoryLedger();
  return { gate: new OperationPolicyGate({ store }), store };
};

describe('operation action-to-verdict table', () => {
  it.each([
    ['shopify.product.read', 'READ', 'READ'],
    ['shopify.order.read', 'READ', 'READ'],
    ['shopify.product.create', 'WRITE', 'REMOTE_WRITE'],
    ['shopify.inventory.adjust', 'WRITE', 'REMOTE_WRITE'],
    ['shopify.order.cancel', 'WRITE', 'HIGH_RISK'],
    ['shopify.refund.create', 'WRITE', 'HIGH_RISK'],
  ] as const)('%s (%s) -> %s', (action, effectClass, expected) => {
    const verdict = classifyOperation(baseIntent({ canonicalAction: action, effectClass }), meta());
    expect(verdict.verdict).toBe(expected);
    expect(verdict.operationHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['shopify.store.delete', 'STORE'],
    ['shopify.account.delete', 'ACCOUNT'],
    ['account.delete', 'ACCOUNT'],
    ['store.delete', 'STORE'],
  ] as const)('DENY default: %s (scope %s)', (action, scope) => {
    const verdict = classifyOperation(
      baseIntent({ canonicalAction: action, effectClass: 'DELETE' }),
      meta({ scope: scope as 'STORE' | 'ACCOUNT' }),
    );
    expect(verdict.verdict).toBe('DENY');
  });

  it('DENY defaults unknown canonical actions (fail-closed)', () => {
    const verdict = classifyOperation(baseIntent({ canonicalAction: 'shopify.unknown.wipe' }), meta());
    expect(verdict.verdict).toBe('DENY');
  });
});

describe('central engine decides risk (adapter cannot self-downgrade)', () => {
  it('ignores a caller-claimed lower risk and keeps HIGH_RISK for refund.create', () => {
    const intent = baseIntent({ canonicalAction: 'shopify.refund.create', effectClass: 'WRITE' });
    const verdict = classifyOperation(intent, meta(), { claimedRisk: 'READ' });
    expect(verdict.verdict).toBe('HIGH_RISK');
  });

  it('ignores a caller-claimed READ for order.cancel', () => {
    const intent = baseIntent({ canonicalAction: 'shopify.order.cancel', effectClass: 'WRITE' });
    const verdict = classifyOperation(intent, meta(), { claimedRisk: 'READ' });
    expect(verdict.verdict).toBe('HIGH_RISK');
  });
});

describe('full-field operation-hash verification', () => {
  it('recomputes the hash and requires re-approval when any identity field changes', () => {
    const intent = baseIntent({ canonicalAction: 'shopify.product.create', effectClass: 'WRITE' });
    const { gate } = gateWithLedger();
    const approval = approvalFor(intent);
    const tampered = { ...intent, parameterDigest: 'tampered-digest' };
    const result = gate.verify(approval, tampered);
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/re-approval/i);
    expect(hashOperationIntent(tampered)).not.toBe(hashOperationIntent(intent));
  });

  it('rejects targetResource mutation as an identity change', () => {
    const intent = baseIntent({ canonicalAction: 'shopify.order.cancel', effectClass: 'WRITE' });
    const { gate } = gateWithLedger();
    const approval = approvalFor(intent);
    expect(gate.verify(approval, { ...intent, targetResource: 'order/999' }).accepted).toBe(false);
  });

  it('rejects expectedVersion mutation as an identity change', () => {
    const intent = baseIntent({ canonicalAction: 'shopify.product.create', effectClass: 'WRITE' });
    const { gate } = gateWithLedger();
    const approval = approvalFor(intent);
    const tampered = { ...intent, expectedVersion: 'v999' };
    expect(hashOperationIntent(tampered)).not.toBe(hashOperationIntent(intent));
    expect(gate.verify(approval, tampered).accepted).toBe(false);
  });

  it('rejects provider/recipe substitution as an identity change', () => {
    const intent = baseIntent({ canonicalAction: 'shopify.refund.create', effectClass: 'WRITE' });
    const { gate } = gateWithLedger();
    const approval = approvalFor(intent);
    const tampered = { ...intent, providerId: 'evil-provider', recipeId: 'evil-recipe' };
    expect(hashOperationIntent(tampered)).not.toBe(hashOperationIntent(intent));
    expect(gate.verify(approval, tampered).accepted).toBe(false);
  });
});

describe('single-use + expiry + cross-task replay rejection', () => {
  it('rejects reuse of a consumed approval (single-use)', () => {
    const intent = baseIntent({ canonicalAction: 'shopify.product.create', effectClass: 'WRITE' });
    const { gate, store } = gateWithLedger();
    const approval = ledgerApproval(store, intent);
    expect(gate.verify(approval, intent).accepted).toBe(true);
    // verify() consumes atomically: a second verify is a single-use replay.
    const replay = gate.verify(approval, intent);
    expect(replay.accepted).toBe(false);
    expect(replay.reason).toMatch(/single-use|consumed/i);
  });

  it('rejects cross-instance double-consume via the shared durable ledger', () => {
    const intent = baseIntent({ canonicalAction: 'shopify.product.create', effectClass: 'WRITE' });
    const store = setupMemoryLedger();
    const gateA = new OperationPolicyGate({ store });
    const gateB = new OperationPolicyGate({ store });
    const approval = ledgerApproval(store, intent);
    expect(gateA.verify(approval, intent).accepted).toBe(true);
    // A second gate instance sharing the ledger must still see the consume.
    const replay = gateB.verify(approval, intent);
    expect(replay.accepted).toBe(false);
    expect(replay.reason).toMatch(/single-use|consumed/i);
  });

  it('rejects cross-task replay (approval bound to a different taskId)', () => {
    const intent = baseIntent({ canonicalAction: 'shopify.product.create', effectClass: 'WRITE' });
    const { gate } = gateWithLedger();
    const approval = approvalFor(intent);
    const otherTask = { ...intent, taskId: 'task-2' };
    // Recompute-proof: hash differs across tasks, approval must not transfer.
    expect(hashOperationIntent(otherTask)).not.toBe(hashOperationIntent(intent));
    expect(gate.verify(approval, otherTask).accepted).toBe(false);
  });

  it('rejects expired approvals (fail-closed)', () => {
    const intent = baseIntent({ canonicalAction: 'shopify.inventory.adjust', effectClass: 'WRITE' });
    const { gate } = gateWithLedger();
    const expired = approvalFor(intent, { expiresAt: Date.now() - 1_000 });
    const result = gate.verify(expired, intent);
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/expir/i);
  });

  it('decideOperation with a ledger consumes: second decision needs re-approval', () => {
    const intent = baseIntent({ canonicalAction: 'shopify.product.create', effectClass: 'WRITE' });
    const store = setupMemoryLedger();
    const approval = ledgerApproval(store, intent);
    expect(decideOperation(intent, meta(), approval, { store }).kind).toBe('ALLOW');
    expect(decideOperation(intent, meta(), approval, { store }).kind).toBe('NEEDS_APPROVAL');
  });
});

describe('APPROVED-only authorization (PENDING/DENIED/EXPIRED/CONSUMED all deny)', () => {
  it.each([['PENDING'], ['DENIED'], ['EXPIRED'], ['CONSUMED']] as const)(
    'denies %s approvals even when hash, task, and expiry are valid',
    (status) => {
      const intent = baseIntent({ canonicalAction: 'shopify.product.create', effectClass: 'WRITE' });
      const { gate } = gateWithLedger();
      const result = gate.verify(approvalFor(intent, { status }), intent);
      expect(result.accepted).toBe(false);
      expect(result.reason).toMatch(/APPROVED/);
    },
  );

  it('PENDING approvals stay NEEDS_APPROVAL through decideOperation', () => {
    const intent = baseIntent({ canonicalAction: 'shopify.product.create', effectClass: 'WRITE' });
    const decision = decideOperation(intent, meta(), approvalFor(intent, { status: 'PENDING' }));
    expect(decision.kind).toBe('NEEDS_APPROVAL');
  });
});

describe('DENY is non-promotable', () => {
  it('approval cannot lift DENY for account deletion', () => {
    const intent = baseIntent({ canonicalAction: 'shopify.account.delete', effectClass: 'DELETE' });
    const decision = decideOperation(intent, meta({ scope: 'ACCOUNT' }), approvalFor(intent));
    expect(decision.kind).toBe('DENY');
    expect(decision.reason).toMatch(/policy change/i);
  });

  it('approval cannot lift DENY for unknown destructive actions', () => {
    const intent = baseIntent({ canonicalAction: 'shopify.unknown.wipe', effectClass: 'DELETE' });
    const decision = decideOperation(intent, meta(), approvalFor(intent));
    expect(decision.kind).toBe('DENY');
  });
});

describe('decision mapping', () => {
  it('maps READ to ALLOW without approval', () => {
    const decision = decideOperation(baseIntent(), meta());
    expect(decision.kind).toBe('ALLOW');
  });

  it('maps REMOTE_WRITE to NEEDS_APPROVAL without approval and ALLOW with valid approval', () => {
    const intent = baseIntent({ canonicalAction: 'shopify.product.create', effectClass: 'WRITE' });
    expect(decideOperation(intent, meta()).kind).toBe('NEEDS_APPROVAL');
    expect(decideOperation(intent, meta(), approvalFor(intent)).kind).toBe('ALLOW');
  });

  it('maps HIGH_RISK to NEEDS_APPROVAL without approval and ALLOW with valid approval', () => {
    const intent = baseIntent({ canonicalAction: 'shopify.refund.create', effectClass: 'WRITE' });
    expect(decideOperation(intent, meta()).kind).toBe('NEEDS_APPROVAL');
    expect(decideOperation(intent, meta(), approvalFor(intent)).kind).toBe('ALLOW');
  });
});

describe('restart replay on a REAL file DB (durable single-use)', () => {
  it('approve -> NEW repository instance on the same file -> second consume FAILS', () => {
    const dir = mkdtempSync(join(tmpdir(), 'policy-restart-'));
    tempDirs.push(dir);
    const path = join(dir, 'restart.db');

    const firstDb = trackDb(new openLedgerDb(path, { timeout: 5_000 }));
    firstDb.exec('PRAGMA journal_mode = WAL;');
    ensureApprovalLedgerSchema(firstDb);
    const first = new PersistentOperationApprovalStore(firstDb);
    const intent = baseIntent({ canonicalAction: 'shopify.product.create', effectClass: 'WRITE' });
    const operationHash = hashOperationIntent(intent);
    const requested = first.request(intent.taskId, operationHash);
    expect(requested.status).toBe('PENDING');
    const approved = first.approve(requested.id, operationHash);
    expect(approved.status).toBe('APPROVED');

    const gateA = new OperationPolicyGate({ store: first });
    expect(gateA.verify(approvalInputFor(approved), intent).accepted).toBe(true);
    expect(first.get(requested.id)?.status).toBe('CONSUMED');

    // Simulate a process restart: close every handle, then reopen the SAME
    // file with a brand-new repository instance. The CONSUMED row survives.
    releaseDb(firstDb);
    const secondDb = trackDb(new openLedgerDb(path, { timeout: 5_000 }));
    ensureApprovalLedgerSchema(secondDb);
    const second = new PersistentOperationApprovalStore(secondDb);
    expect(second.get(requested.id)?.status).toBe('CONSUMED');

    // Second consume on the new instance FAILS: single-use holds across restart.
    expect(second.consume(intent.taskId, operationHash)).toBe(false);
    const gateB = new OperationPolicyGate({ store: second });
    const replay = gateB.verify(approvalInputFor(approved), intent);
    expect(replay.accepted).toBe(false);
    expect(replay.reason).toMatch(/single-use|consumed/i);
  });
});
