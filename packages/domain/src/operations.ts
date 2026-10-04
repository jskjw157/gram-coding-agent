import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { PolicyDecisionKind } from './policy.js';
import type { TaskId } from './task.js';

export type TaskKind = 'QUERY' | 'COMMAND' | 'WORKFLOW';

export type ExecutionMode = 'FIXTURE' | 'READ_ONLY' | 'WRITE_APPROVED';

export type EffectClass = 'READ' | 'WRITE' | 'DELETE';

export type Scope = 'RESOURCE' | 'STORE' | 'ACCOUNT';

export interface ArtifactRef {
  artifactId: string;
  digest: string;
  version?: string;
}

export interface CreateOperationInput {
  taskId: TaskId;
  taskKind: TaskKind;
  executionMode: ExecutionMode;
  canonicalAction: string;
  storeId: string;
  accountId: string;
  targetResource: string;
  parameterDigest: string;
  effectClass: EffectClass;
  expectedState: string;
  expectedVersion: string;
  providerId: string;
  recipeId: string;
  scope: Scope;
}

export interface OperationIntent {
  taskId: TaskId;
  operationId: string;
  canonicalAction: string;
  storeId: string;
  accountId: string;
  targetResource: string;
  parameterDigest: string;
  effectClass: EffectClass;
  expectedState: string;
  expectedVersion: string;
  providerId: string;
  recipeId: string;
}

export interface EffectReceipt {
  operationId: string;
  operationHash: string;
  effectClass: EffectClass;
  policyDecision: PolicyDecisionKind;
  appliedAt: string;
  artifacts: ArtifactRef[];
}

export interface OperationMetadata {
  executionMode: ExecutionMode;
  taskKind: TaskKind;
  scope: Scope;
}

export interface OperationAdapter {
  submit(intent: OperationIntent, metadata: OperationMetadata): Promise<EffectReceipt>;
}

export class OperationContractError extends Error {
  override name = 'OperationContractError';
}

const taskKinds: readonly TaskKind[] = ['QUERY', 'COMMAND', 'WORKFLOW'];
const executionModes: readonly ExecutionMode[] = ['FIXTURE', 'READ_ONLY', 'WRITE_APPROVED'];
const effectClasses: readonly EffectClass[] = ['READ', 'WRITE', 'DELETE'];
const scopes: readonly Scope[] = ['RESOURCE', 'STORE', 'ACCOUNT'];
const policyDecisions: readonly PolicyDecisionKind[] = ['ALLOW', 'NEEDS_APPROVAL', 'DENY'];

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
] as const;

const inputFields = [
  'taskId',
  'taskKind',
  'executionMode',
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
  'scope',
] as const;

const receiptFields = [
  'operationId',
  'operationHash',
  'effectClass',
  'policyDecision',
  'appliedAt',
  'artifacts',
] as const;

const artifactFields = ['artifactId', 'digest', 'version'] as const;

const assertRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OperationContractError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
};

const assertExactKeys = (
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void => {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new OperationContractError(`${label} rejects unknown key: ${key}`);
    }
  }
  for (const key of allowed) {
    if (key !== 'version' && !(key in record)) {
      throw new OperationContractError(`${label} is missing required key: ${key}`);
    }
  }
};

const assertNonEmptyString = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new OperationContractError(`${label} must be a non-empty string`);
  }
  return value;
};

const assertEnum = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T => {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new OperationContractError(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
};

const parseArtifactRef = (value: unknown): ArtifactRef => {
  const record = assertRecord(value, 'ArtifactRef');
  assertExactKeys(record, artifactFields, 'ArtifactRef');
  const ref: ArtifactRef = {
    artifactId: assertNonEmptyString(record['artifactId'], 'artifacts[].artifactId'),
    digest: assertNonEmptyString(record['digest'], 'artifacts[].digest'),
  };
  if ('version' in record) {
    ref.version = assertNonEmptyString(record['version'], 'artifacts[].version');
  }
  return ref;
};

const parseArtifacts = (value: unknown): ArtifactRef[] => {
  if (!Array.isArray(value)) {
    throw new OperationContractError('artifacts must be an array');
  }
  return value.map((entry) => parseArtifactRef(entry as unknown));
};

export const parseCreateOperationInput = (value: unknown): CreateOperationInput => {
  const record = assertRecord(value, 'CreateOperationInput');
  assertExactKeys(record, inputFields, 'CreateOperationInput');
  return {
    taskId: assertNonEmptyString(record['taskId'], 'taskId'),
    taskKind: assertEnum(record['taskKind'], taskKinds, 'taskKind'),
    executionMode: assertEnum(record['executionMode'], executionModes, 'executionMode'),
    canonicalAction: assertNonEmptyString(record['canonicalAction'], 'canonicalAction'),
    storeId: assertNonEmptyString(record['storeId'], 'storeId'),
    accountId: assertNonEmptyString(record['accountId'], 'accountId'),
    targetResource: assertNonEmptyString(record['targetResource'], 'targetResource'),
    parameterDigest: assertNonEmptyString(record['parameterDigest'], 'parameterDigest'),
    effectClass: assertEnum(record['effectClass'], effectClasses, 'effectClass'),
    expectedState: assertNonEmptyString(record['expectedState'], 'expectedState'),
    expectedVersion: assertNonEmptyString(record['expectedVersion'], 'expectedVersion'),
    providerId: assertNonEmptyString(record['providerId'], 'providerId'),
    recipeId: assertNonEmptyString(record['recipeId'], 'recipeId'),
    scope: assertEnum(record['scope'], scopes, 'scope'),
  };
};

export const parseOperationIntent = (value: unknown): OperationIntent => {
  const record = assertRecord(value, 'OperationIntent');
  assertExactKeys(record, identityFields, 'OperationIntent');
  return {
    taskId: assertNonEmptyString(record['taskId'], 'taskId'),
    operationId: assertNonEmptyString(record['operationId'], 'operationId'),
    canonicalAction: assertNonEmptyString(record['canonicalAction'], 'canonicalAction'),
    storeId: assertNonEmptyString(record['storeId'], 'storeId'),
    accountId: assertNonEmptyString(record['accountId'], 'accountId'),
    targetResource: assertNonEmptyString(record['targetResource'], 'targetResource'),
    parameterDigest: assertNonEmptyString(record['parameterDigest'], 'parameterDigest'),
    effectClass: assertEnum(record['effectClass'], effectClasses, 'effectClass'),
    expectedState: assertNonEmptyString(record['expectedState'], 'expectedState'),
    expectedVersion: assertNonEmptyString(record['expectedVersion'], 'expectedVersion'),
    providerId: assertNonEmptyString(record['providerId'], 'providerId'),
    recipeId: assertNonEmptyString(record['recipeId'], 'recipeId'),
  };
};

export const parseEffectReceipt = (value: unknown): EffectReceipt => {
  const record = assertRecord(value, 'EffectReceipt');
  assertExactKeys(record, receiptFields, 'EffectReceipt');
  return {
    operationId: assertNonEmptyString(record['operationId'], 'operationId'),
    operationHash: assertNonEmptyString(record['operationHash'], 'operationHash'),
    effectClass: assertEnum(record['effectClass'], effectClasses, 'effectClass'),
    policyDecision: assertEnum(record['policyDecision'], policyDecisions, 'policyDecision'),
    appliedAt: assertNonEmptyString(record['appliedAt'], 'appliedAt'),
    artifacts: parseArtifacts(record['artifacts']),
  };
};

export const createOperationId = (): string => uuidv7();

export const createOperationIntent = (input: CreateOperationInput): OperationIntent => {
  const parsed = parseCreateOperationInput(input as unknown);
  return {
    taskId: parsed.taskId,
    operationId: createOperationId(),
    canonicalAction: parsed.canonicalAction,
    storeId: parsed.storeId,
    accountId: parsed.accountId,
    targetResource: parsed.targetResource,
    parameterDigest: parsed.parameterDigest,
    effectClass: parsed.effectClass,
    expectedState: parsed.expectedState,
    expectedVersion: parsed.expectedVersion,
    providerId: parsed.providerId,
    recipeId: parsed.recipeId,
  };
};

export const operationHash = (intent: OperationIntent): string => {
  const parsed = parseOperationIntent(intent as unknown);
  const ordered: Record<string, string> = {};
  for (const field of identityFields) {
    ordered[field] = parsed[field];
  }
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
};
