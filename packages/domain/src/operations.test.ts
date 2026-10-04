import { describe, expect, it } from 'vitest';
import {
  createOperationIntent,
  operationHash,
  parseCreateOperationInput,
  parseEffectReceipt,
  parseOperationIntent,
  type CreateOperationInput,
  type EffectClass,
  type ExecutionMode,
  type OperationAdapter,
  type OperationIntent,
  type Scope,
  type TaskKind,
} from './operations.js';

const validInput: CreateOperationInput = {
  taskId: '0193e5f0-7c9a-7b1e-9c0d-1a2b3c4d5e6f',
  taskKind: 'COMMAND',
  executionMode: 'WRITE_APPROVED',
  canonicalAction: 'shopify.product.create',
  storeId: 'store-001',
  accountId: 'acct-001',
  targetResource: 'products',
  parameterDigest: 'sha256:abc123',
  effectClass: 'WRITE',
  expectedState: 'DRAFT',
  expectedVersion: 'v1',
  providerId: 'shopify',
  recipeId: 'recipe-listing-create',
  scope: 'STORE',
};

describe('Operations domain contract', () => {
  it('exposes the fixed ExecutionMode union', () => {
    const modes: ExecutionMode[] = ['FIXTURE', 'READ_ONLY', 'WRITE_APPROVED'];
    expect(modes).toHaveLength(3);
    expect(validInput.executionMode).toBe('WRITE_APPROVED');
  });

  it('exposes fixed TaskKind, EffectClass and Scope unions', () => {
    const kinds: TaskKind[] = ['QUERY', 'COMMAND', 'WORKFLOW'];
    const effects: EffectClass[] = ['READ', 'WRITE', 'DELETE'];
    const scopes: Scope[] = ['RESOURCE', 'STORE', 'ACCOUNT'];
    expect(kinds).toHaveLength(3);
    expect(effects).toHaveLength(3);
    expect(scopes).toHaveLength(3);
  });

  it('creates an intent carrying exactly the D11 identity field set', () => {
    const intent = createOperationIntent(validInput);
    expect(Object.keys(intent).sort()).toEqual(
      [
        'accountId',
        'canonicalAction',
        'effectClass',
        'expectedState',
        'expectedVersion',
        'operationId',
        'parameterDigest',
        'providerId',
        'recipeId',
        'storeId',
        'targetResource',
        'taskId',
      ].sort(),
    );
  });

  it('generates RFC9562 version 7 operation ids', () => {
    const intent = createOperationIntent(validInput);
    expect(intent.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('computes a stable order-fixed SHA-256 operation hash', () => {
    const intent = createOperationIntent(validInput);
    const reordered = Object.fromEntries(Object.entries(intent).reverse()) as OperationIntent;
    expect(operationHash(reordered)).toBe(operationHash(intent));
    expect(operationHash(intent)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes the hash when any identity field changes', () => {
    const intent = createOperationIntent(validInput);
    const base = operationHash(intent);
    const mutations: Array<Partial<OperationIntent>> = [
      { taskId: 'other-task' },
      { operationId: 'other-op' },
      { canonicalAction: 'other.action' },
      { storeId: 'other-store' },
      { accountId: 'other-acct' },
      { targetResource: 'other-resource' },
      { parameterDigest: 'other-digest' },
      { effectClass: 'READ' },
      { expectedState: 'PUBLISHED' },
      { expectedVersion: 'v2' },
      { providerId: 'other-provider' },
      { recipeId: 'other-recipe' },
    ];
    expect(mutations).toHaveLength(12);
    for (const mutation of mutations) {
      expect(operationHash({ ...intent, ...mutation })).not.toBe(base);
    }
  });

  it('keeps risk tier out of the contract', () => {
    const intent = createOperationIntent(validInput);
    expect('riskTier' in intent).toBe(false);
    expect(() =>
      parseOperationIntent({ ...(intent as unknown as Record<string, unknown>), riskTier: 'HIGH' }),
    ).toThrow();
  });

  it('rejects unknown keys and malformed shapes on strict parse', () => {
    expect(() =>
      parseCreateOperationInput({ ...validInput, extra: 'nope' } as Record<string, unknown>),
    ).toThrow();
    expect(() => parseCreateOperationInput({ ...validInput, storeId: 42 })).toThrow();
    expect(() => parseCreateOperationInput(null)).toThrow();
    const intent = createOperationIntent(validInput);
    expect(() =>
      parseOperationIntent({ ...(intent as unknown as Record<string, unknown>), unknownKey: 1 }),
    ).toThrow();
    expect(() => parseOperationIntent({ ...intent, effectClass: 'NOVA' })).toThrow();
  });

  it('round-trips a parsed intent with an identical hash', () => {
    const intent = createOperationIntent(validInput);
    const parsed = parseOperationIntent(JSON.parse(JSON.stringify(intent)) as unknown);
    expect(operationHash(parsed)).toBe(operationHash(intent));
  });

  it('keeps EffectReceipt sanitized with no raw body', () => {
    const intent = createOperationIntent(validInput);
    const receipt = {
      operationId: intent.operationId,
      operationHash: operationHash(intent),
      effectClass: intent.effectClass,
      policyDecision: 'ALLOW',
      appliedAt: '2026-10-04T00:00:00.000Z',
      artifacts: [{ artifactId: 'art-1', digest: 'sha256:def456', version: 'v1' }],
    } as const;
    const parsed = parseEffectReceipt(receipt as unknown);
    expect('rawBody' in parsed).toBe(false);
    expect('body' in parsed).toBe(false);
    expect(() =>
      parseEffectReceipt({ ...(receipt as Record<string, unknown>), rawBody: '{secret}' }),
    ).toThrow();
    expect(() => parseEffectReceipt({ ...(receipt as Record<string, unknown>), body: 'x' })).toThrow();
  });

  it('lets an adapter submit the canonical action plus metadata', async () => {
    const intent = createOperationIntent(validInput);
    let seenAction = '';
    let seenMode: ExecutionMode = 'FIXTURE';
    const adapter: OperationAdapter = {
      submit: async (submitted, metadata) => {
        seenAction = submitted.canonicalAction;
        seenMode = metadata.executionMode;
        return {
          operationId: submitted.operationId,
          operationHash: operationHash(submitted),
          effectClass: submitted.effectClass,
          policyDecision: 'ALLOW',
          appliedAt: '2026-10-04T00:00:00.000Z',
          artifacts: [],
        };
      },
    };
    const receipt = await adapter.submit(intent, {
      executionMode: validInput.executionMode,
      taskKind: validInput.taskKind,
      scope: validInput.scope,
    });
    expect(seenAction).toBe('shopify.product.create');
    expect(seenMode).toBe('WRITE_APPROVED');
    expect(receipt.operationHash).toBe(operationHash(intent));
  });
});
