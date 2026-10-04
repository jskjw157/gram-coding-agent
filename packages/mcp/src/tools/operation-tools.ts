// operation-tools.ts — strict-schemed MCP tools exposing fixture task ops
// (MAC-03 WP-12, decision D11: MCP safe metadata).
//
// - Every tool carries a strict input schema (exact keys; additionalProperties
//   is always false) and validates before touching the runner port.
// - Metadata is SAFE FIELDS ONLY (see SAFE_METADATA_FIELDS); anything else —
//   including identity material such as api tokens, store/account ids, or a
//   scope that does not match the caller context — is an UnsafeMetadataError.
// - Receipts are redacted: the tools re-derive an identity-free operationHash
//   and strip every internal field before returning.
// - The runner is an injected structural port, so this module adds no workspace
//   dependencies; composition wires the real runner under FIXTURE only.
import { createHash } from 'node:crypto';

export const SAFE_METADATA_FIELDS = [
  'effectClass',
  'executionMode',
  'recipeId',
  'scope',
  'taskKind',
] as const;

export type SafeMetadataField = (typeof SAFE_METADATA_FIELDS)[number];

export type FixtureToolScope = 'RESOURCE' | 'STORE' | 'ACCOUNT';

const toolScopes: readonly FixtureToolScope[] = ['RESOURCE', 'STORE', 'ACCOUNT'];

export const FIXTURE_TOOL_NAMES = [
  'fixture_task_create',
  'fixture_task_execute',
  'fixture_task_receipt',
  'fixture_task_resume',
  'fixture_schedule_consume',
] as const;

export type FixtureToolName = (typeof FIXTURE_TOOL_NAMES)[number];

export class OperationToolError extends Error {
  override name = 'OperationToolError';
}

export class UnknownToolError extends OperationToolError {
  override name = 'UnknownToolError';
}

export class ToolSchemaError extends OperationToolError {
  override name = 'ToolSchemaError';
}

export class UnsafeMetadataError extends OperationToolError {
  override name = 'UnsafeMetadataError';
}

export interface ToolContext {
  readonly requester: string;
  readonly scope: FixtureToolScope;
}

export interface SafeReceiptArtifact {
  readonly artifactId: string;
  readonly digest: string;
}

export interface SafeReceipt {
  readonly operationId: string;
  readonly operationHash: string;
  readonly effectClass: string;
  readonly policyDecision: string;
  readonly appliedAt: string;
  readonly artifacts: readonly SafeReceiptArtifact[];
}

/** Internal receipt shape the runner port may return (extra fields stripped). */
export interface RunnerReceiptLike {
  readonly operationId: string;
  readonly operationHash: string;
  readonly effectClass: string;
  readonly policyDecision: string;
  readonly appliedAt: string;
  readonly artifacts: readonly { readonly artifactId: string; readonly digest: string }[];
  readonly internal?: unknown;
}

export interface FixtureRunnerPort {
  createTask(input: { recipeId: string; requester: string }): {
    taskId: string;
    recipeId: string;
    checkpointDigest: string;
  };
  execute(taskId: string): RunnerReceiptLike;
  resume(taskId: string, checkpointDigest?: string): { taskId: string; checkpointDigest: string };
  inspect?(taskId: string): RunnerReceiptLike;
  consumeScheduleEntry?(entry: { scheduleEntryId: string; taskId: string }): RunnerReceiptLike;
}

export interface OperationToolInputSchema {
  readonly type: 'object';
  readonly properties: Record<string, { readonly type: string }>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}

export interface OperationTool {
  readonly name: FixtureToolName;
  readonly description: string;
  readonly inputSchema: OperationToolInputSchema;
  readonly handler: (input: unknown, context: ToolContext) => Promise<unknown>;
}

const shaHex = (input: string): string => createHash('sha256').update(input, 'utf8').digest('hex');

const assertRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ToolSchemaError(`${label} must be an object`);
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
      throw new ToolSchemaError(`${label} rejects unknown key: ${key}`);
    }
  }
};

const assertNonEmptyString = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ToolSchemaError(`${label} must be a non-empty string`);
  }
  return value;
};

const assertSafeMetadata = (
  value: unknown,
  context: ToolContext,
  label: string,
): Record<string, string> => {
  if (value === undefined) return {};
  const record = assertRecord(value, label);
  for (const key of Object.keys(record)) {
    if (!(SAFE_METADATA_FIELDS as readonly string[]).includes(key)) {
      throw new UnsafeMetadataError(`${label} allows SAFE FIELDS ONLY, rejected: ${key}`);
    }
  }
  const metadata: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== 'string') {
      throw new UnsafeMetadataError(`${label}.${key} must be a string`);
    }
    metadata[key] = entry;
  }
  const scope = metadata['scope'];
  if (scope !== undefined) {
    if (!(toolScopes as readonly string[]).includes(scope)) {
      throw new UnsafeMetadataError(`${label}.scope must be one of: ${toolScopes.join(', ')}`);
    }
    if (scope !== context.scope) {
      throw new UnsafeMetadataError(
        `${label}.scope ${scope} does not match caller scope ${context.scope}`,
      );
    }
  }
  const executionMode = metadata['executionMode'];
  if (executionMode !== undefined && executionMode !== 'FIXTURE') {
    throw new UnsafeMetadataError(`${label}.executionMode must be FIXTURE, found ${executionMode}`);
  }
  return metadata;
};

const assertContext = (context: ToolContext): void => {
  if (typeof context.requester !== 'string' || context.requester.length === 0) {
    throw new ToolSchemaError('context.requester must be a non-empty string');
  }
  if (!(toolScopes as readonly string[]).includes(context.scope)) {
    throw new ToolSchemaError(`context.scope must be one of: ${toolScopes.join(', ')}`);
  }
};

/**
 * Redact a runner receipt: re-derive an identity-free operationHash and keep
 * SAFE receipt fields only. The runner's own hash (and any `internal` identity
 * material) never leaves this boundary.
 */
export const toSafeReceipt = (receipt: RunnerReceiptLike): SafeReceipt => ({
  operationId: receipt.operationId,
  operationHash: shaHex(`${receipt.operationId}|${receipt.effectClass}`),
  effectClass: receipt.effectClass,
  policyDecision: receipt.policyDecision,
  appliedAt: receipt.appliedAt,
  artifacts: receipt.artifacts.map((artifact) => ({
    artifactId: artifact.artifactId,
    digest: artifact.digest,
  })),
});

const attestedReceipt = (taskId: string, effectClass: string): SafeReceipt => ({
  operationId: taskId,
  operationHash: shaHex(`${taskId}|${effectClass}`),
  effectClass,
  policyDecision: 'ALLOW',
  appliedAt: new Date(0).toISOString(),
  artifacts: [],
});

const defineTool = (
  name: FixtureToolName,
  description: string,
  required: readonly string[],
  handler: (input: unknown, context: ToolContext) => Promise<unknown>,
): OperationTool => {
  const properties: Record<string, { readonly type: string }> = {};
  for (const key of [...required, 'metadata']) properties[key] = { type: 'string' };
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, handler };
};

export const createFixtureOperationTools = (
  runner: FixtureRunnerPort,
  only?: readonly string[],
): OperationTool[] => {
  const requested: readonly string[] = only ?? [...FIXTURE_TOOL_NAMES];
  for (const name of requested) {
    if (!(FIXTURE_TOOL_NAMES as readonly string[]).includes(name)) {
      throw new UnknownToolError(`unknown fixture operation tool: ${name}`);
    }
  }

  const tools: OperationTool[] = [
    defineTool(
      'fixture_task_create',
      'Create a FIXTURE task from a fixture recipe.',
      ['recipeId'],
      async (input, context) => {
        assertContext(context);
        const record = assertRecord(input, 'fixture_task_create input');
        assertExactKeys(record, ['recipeId', 'metadata'], 'fixture_task_create input');
        const recipeId = assertNonEmptyString(record['recipeId'], 'recipeId');
        const metadata = assertSafeMetadata(record['metadata'], context, 'metadata');
        const task = runner.createTask({ recipeId, requester: context.requester });
        return {
          task,
          receipt: attestedReceipt(task.taskId, metadata['effectClass'] ?? 'READ'),
        };
      },
    ),
    defineTool(
      'fixture_task_execute',
      'Execute an owned FIXTURE task and return a redacted receipt.',
      ['taskId'],
      async (input, context) => {
        assertContext(context);
        const record = assertRecord(input, 'fixture_task_execute input');
        assertExactKeys(record, ['taskId', 'metadata'], 'fixture_task_execute input');
        const taskId = assertNonEmptyString(record['taskId'], 'taskId');
        assertSafeMetadata(record['metadata'], context, 'metadata');
        return { receipt: toSafeReceipt(runner.execute(taskId)) };
      },
    ),
    defineTool(
      'fixture_task_receipt',
      'Return the redacted receipt for a FIXTURE task without re-executing.',
      ['taskId'],
      async (input, context) => {
        assertContext(context);
        const record = assertRecord(input, 'fixture_task_receipt input');
        assertExactKeys(record, ['taskId', 'metadata'], 'fixture_task_receipt input');
        const taskId = assertNonEmptyString(record['taskId'], 'taskId');
        assertSafeMetadata(record['metadata'], context, 'metadata');
        if (runner.inspect === undefined) {
          throw new ToolSchemaError('fixture_task_receipt is unavailable on this runner port');
        }
        return { receipt: toSafeReceipt(runner.inspect(taskId)) };
      },
    ),
    defineTool(
      'fixture_task_resume',
      'Resume a FIXTURE task from a matching checkpoint digest.',
      ['taskId', 'checkpointDigest'],
      async (input, context) => {
        assertContext(context);
        const record = assertRecord(input, 'fixture_task_resume input');
        assertExactKeys(record, ['taskId', 'checkpointDigest', 'metadata'], 'fixture_task_resume input');
        const taskId = assertNonEmptyString(record['taskId'], 'taskId');
        const checkpointDigest = assertNonEmptyString(record['checkpointDigest'], 'checkpointDigest');
        assertSafeMetadata(record['metadata'], context, 'metadata');
        return { task: runner.resume(taskId, checkpointDigest) };
      },
    ),
    defineTool(
      'fixture_schedule_consume',
      'Consume a schedule entry through the same fixture engine (no second scheduler).',
      ['scheduleEntryId', 'taskId'],
      async (input, context) => {
        assertContext(context);
        const record = assertRecord(input, 'fixture_schedule_consume input');
        assertExactKeys(
          record,
          ['scheduleEntryId', 'taskId', 'metadata'],
          'fixture_schedule_consume input',
        );
        const scheduleEntryId = assertNonEmptyString(record['scheduleEntryId'], 'scheduleEntryId');
        const taskId = assertNonEmptyString(record['taskId'], 'taskId');
        assertSafeMetadata(record['metadata'], context, 'metadata');
        if (runner.consumeScheduleEntry === undefined) {
          throw new ToolSchemaError('fixture_schedule_consume is unavailable on this runner port');
        }
        return { receipt: toSafeReceipt(runner.consumeScheduleEntry({ scheduleEntryId, taskId })) };
      },
    ),
  ];

  const wanted = new Set(requested);
  return tools.filter((tool) => wanted.has(tool.name));
};
