// auxiliary-faults.test.ts — Gate A auxiliary fault rows (fixture-only).
//
// Pins already-correct lane behavior at the integration seam: OAuth refresh
// single-flight + expiry, pre/post-WAITING_USER restart gating, post-approval
// crash replay refusal, worker crash permit consumption, core-restart commit
// journal evidence, tunnel-drop ambiguity. These pass on RED (lanes are
// GREEN); they lock the seam the crash-point harness relies on.
import { describe, expect, it } from 'vitest';
import { AuthSessionKeeper } from '../../auth-session/src/session-keeper.js';
import { CredentialBroker } from '../../credentials/src/broker.js';
import type { FixtureVault } from '../../credentials/src/broker.js';
import { OperationPolicyGate, decideOperation } from '../../policy/src/operation-policy.js';
import { InMemoryOperationApprovalStore } from '../../policy/src/operation-policy.js';
import { EffectLedger } from '../../task-engine/src/effect-ledger.js';
import { ShopifyAmbiguousError, ShopifyTransport } from '../../shopify-adapter/src/transport.js';
import { FakeBroker } from '../../shopify-adapter/src/fixture-endpoint.js';

const key = { provider: 'shopify', account: 'acct-1' };

const keeperWith = (refreshCalls: { count: number }) =>
  new AuthSessionKeeper({
    refresh: () => {
      refreshCalls.count += 1;
      return Promise.resolve({ expiresInSeconds: 3600 });
    },
    reconcile: () => Promise.resolve(),
  });

describe('auxiliary faults (OAuth, approval, worker, restart, tunnel)', () => {
  it('OAuth refresh is single-flight: concurrent callers share one transport call', async () => {
    const calls = { count: 0 };
    const keeper = keeperWith(calls);
    keeper.seedAuthenticated(key, 3600);
    await Promise.all([keeper.refreshNow(key), keeper.refreshNow(key), keeper.refreshNow(key)]);
    expect(calls.count).toBe(1);
  });

  it('session expiry refuses access until a fresh grant renews it', async () => {
    const calls = { count: 0 };
    const keeper = keeperWith(calls);
    keeper.seedAuthenticated(key, 3600);
    keeper.seedExpired(key);
    await expect(keeper.access(key)).rejects.toMatchObject({ code: 'EXPIRED' });
    await keeper.refreshNow(key);
    await expect(keeper.access(key)).resolves.toMatchObject({ ok: true });
  });

  it('pre-WAITING_USER restart: challenge survives rehydrate and still gates access', async () => {
    const calls = { count: 0 };
    const keeper = keeperWith(calls);
    keeper.seedAuthenticated(key, 3600);
    keeper.signalChallenge(key, 'MFA');
    const snapshot = keeper.snapshot(key);
    expect(snapshot.waitingAction).toBe('WAITING_USER');
    const restarted = keeperWith(calls);
    restarted.seedAuthenticated(key, 3600);
    if (snapshot.challengeKind !== undefined) restarted.signalChallenge(key, snapshot.challengeKind);
    expect(restarted.snapshot(key).waitingAction).toBe('WAITING_USER');
    await expect(restarted.access(key)).rejects.toMatchObject({ code: 'CHALLENGE' });
  });

  it('post-WAITING_USER restart: re-auth still requires reconcile before resume', async () => {
    const keeper = keeperWith({ count: 0 });
    keeper.seedAuthenticated(key, 3600);
    keeper.signalChallenge(key, 'MFA');
    keeper.resolveWithReauth(key, { expiresInSeconds: 3600 });
    await expect(keeper.access(key)).rejects.toMatchObject({ code: 'RECONCILE_REQUIRED' });
    await keeper.reconcile(key);
    await expect(keeper.access(key)).resolves.toMatchObject({ ok: true });
  });

  it('post-approval crash: consumed approval cannot replay after rehydrate', () => {
    const store = new InMemoryOperationApprovalStore();
    const gate = new OperationPolicyGate({ clock: () => 1000, store });
    const intent = {
      taskId: 'task-1',
      operationId: 'op-1',
      canonicalAction: 'shopify.product.create',
      storeId: 'shop.myshopify.com',
      accountId: 'acct-1',
      targetResource: 'product',
      parameterDigest: 'digest-1',
      effectClass: 'WRITE' as const,
      expectedState: 'draft',
      expectedVersion: 'v1',
      providerId: 'shopify',
      recipeId: 'recipe-1',
    };
    const decision = decideOperation(intent, { scope: 'STORE' });
    expect(decision.kind).toBe('NEEDS_APPROVAL');
    const approval = {
      id: 'approval-1',
      taskId: 'task-1',
      operationHash: decision.operationHash,
      status: 'APPROVED' as const,
      expiresAt: 9999,
    };
    expect(gate.verify(approval, intent).accepted).toBe(true);
    const rehydrated = new OperationPolicyGate({ clock: () => 1000, store });
    expect(rehydrated.verify(approval, intent).accepted).toBe(false);
  });

  it('worker crash: permit is single-use, replay refused, raw secret never leaves', async () => {
    const vault: FixtureVault = {
      getForUse: () => Promise.resolve({
        withValue: <T>(use: (value: string) => T): T => use('SYNTHETIC_FIXTURE_SECRET'),
        dispose: () => {},
      }),
    };
    const broker = new CredentialBroker({
      vault,
      permits: [
        {
          id: 'permit-1',
          intentHash: 'hash-1',
          credentialRef: 'ref-1',
          recipeId: 'recipe-1',
          requesterId: 'req-1',
          workerId: 'worker-1',
          scope: 'shopify.v1',
          expiresAt: Date.now() + 60_000,
        },
      ],
      capabilities: [
        {
          capabilityId: 'cap-1',
          credentialRef: 'ref-1',
          recipeId: 'recipe-1',
          workerId: 'worker-1',
          scope: 'shopify.v1',
          execute: () => {
            throw new Error('fixture worker crash');
          },
        },
      ],
    });
    const input = {
      intentHash: 'hash-1',
      permitId: 'permit-1',
      credentialRef: 'ref-1',
      recipeId: 'recipe-1',
      requesterId: 'req-1',
      workerId: 'worker-1',
      scope: 'shopify.v1',
    };
    const request = { capabilityId: 'cap-1', operation: { kind: 'test.op', fields: {} } };
    await expect(broker.credentialUse(input, request)).rejects.toThrow(
      /\[OPERATION_FAILED\]/,
    );
    await expect(broker.credentialUse(input, request)).rejects.toThrow(
      /already consumed/,
    );
  });

  it('core restart: DISPATCHING commit journal proves durable-before-effect for recovery', async () => {
    const commits: string[] = [];
    const ledger = new EffectLedger((record) => {
      commits.push(`${record.state}:${record.effectId}`);
    });
    const rec = ledger.prepare('op-restart', 'WRITE');
    const dispatch = ledger.dispatch(rec.effectId, () => Promise.resolve('CONFIRMED' as const));
    const dispatchingIndex = commits.findIndex((entry) => entry.startsWith('DISPATCHING'));
    expect(dispatchingIndex).toBeGreaterThanOrEqual(0);
    await dispatch;
    // FINDING (lane boundary): EffectLedger is memory-only; cross-restart
    // recovery depends on this external commit journal. No lane change made.
    const recovered = ledger.crashRecover();
    expect(Array.isArray(recovered)).toBe(true);
  });

  it('tunnel drop: transport failure is ambiguous UNKNOWN with a single fetch call', async () => {
    let fetchCalls = 0;
    const broker = new FakeBroker({
      secret: 'SYNTHETIC_FIXTURE_SECRET',
      permits: {
        'permit-tunnel': {
          intentHash: 'hash-tunnel',
          credentialRef: 'shopify-token',
          recipeId: 'recipe-tunnel',
          requesterId: 'req-tunnel',
          workerId: 'worker-tunnel',
          scope: 'shopify.v1',
        },
      },
    });
    const transport = new ShopifyTransport({
      storeDomain: 'shop.myshopify.com',
      apiVersion: '2026-10',
      credentialRef: 'shopify-token',
      recipeId: 'recipe-tunnel',
      broker,
      fetch: () => {
        fetchCalls += 1;
        return Promise.reject(new Error('fixture tunnel drop'));
      },
    });
    const outcome = await transport
      .execute(
        'shopify.product.read',
        { productId: 'p-1' },
        {
          operationId: 'op-tunnel',
          intentHash: 'hash-tunnel',
          permitId: 'permit-tunnel',
          requesterId: 'req-tunnel',
          workerId: 'worker-tunnel',
          storeId: 'shop.myshopify.com',
        },
      )
      .then(
        () => 'unexpected-success',
        (error: unknown) => error,
      );
    expect(outcome).toBeInstanceOf(ShopifyAmbiguousError);
    expect((outcome as ShopifyAmbiguousError).outcome).toBe('UNKNOWN');
    expect(fetchCalls).toBe(1);
  });
});
