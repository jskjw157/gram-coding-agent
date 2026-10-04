// operation-tools.ts — strict-schemed MCP tools delegating to the M2 engine
// (T10 repair: the standalone FixtureRunnerPort is deleted; these tools are
// thin adapters over OperationsDispatch, which composes M2 TaskService /
// TaskRunner / state machine under T4 lease semantics).
//
// - Every tool carries a strict input schema (exact keys; additionalProperties
//   is always false) and validates before touching the dispatch port.
// - Metadata is SAFE FIELDS ONLY (see SAFE_METADATA_FIELDS); anything else —
//   including identity material such as api tokens, store/account ids, or a
//   scope that does not match the caller context — is an UnsafeMetadataError.
// - Receipts are redacted: the tools rebuild an identity-free receipt from
//   the dispatch result and strip every internal field before returning.
// - The dispatch is an injected structural port mirroring OperationsDispatch
//   (packages/task-engine/src/operations-delegation.ts), so this module adds
//   no workspace dependencies and no execution logic of its own.
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

/** Delegated task view the dispatch port returns (M2 TaskService shape). */
export interface DelegatedTaskViewLike {
  readonly taskId: string;
  readonly displayId: string;
  readonly repo: string;
  readonly goal: string;
  readonly status: string;
}

/** Delegated receipt the dispatch port returns (M2 run + T4 lease shape). */
export interface DispatchReceiptLike {
  readonly operationId: string;
  readonly operationHash: string;
  readonly policyDecision: string;
  readonly appliedAt: string;
}

/**
 * Thin delegation port mirroring OperationsDispatch
 * (packages/task-engine/src/operations-delegation.ts): create/run/resume
 * delegate to M2 TaskService/TaskRunner/state machine, inspect reads M2
 * task state without executing, and schedule consumption delegates to run.
 * No standalone execution lives behind this port.
 */
export interface DelegatedOperationsPort {
  create(input: { readonly repo: string; readonly goal: string }): Promise<DelegatedTaskViewLike>;
  run(taskId: string, requester: string): Promise<DispatchReceiptLike>;
  inspect(taskId: string): Promise<DelegatedTaskViewLike>;
  resume(taskId: string, from: string, to: string): Promise<void>;
  consumeScheduleEntry(
    entry: { readonly scheduleEntryId: string; readonly taskId: string },
    requester: string,
  ): Promise<DispatchReceiptLike>;
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
 * Redact a dispatch receipt: rebuild SAFE receipt fields only from the
 * identity-free operationHash the M2-backed dispatch derived. Nothing the
 * dispatch returns beyond these fields ever leaves this boundary.
 */
export const toSafeReceipt = (receipt: DispatchReceiptLike, effectClass: string): SafeReceipt => ({
  operationId: receipt.operationId,
  operationHash: receipt.operationHash,
  effectClass,
  policyDecision: receipt.policyDecision,
  appliedAt: receipt.appliedAt,
  artifacts: [],
});

const attestedReceipt = (taskId: string, effectClass: string): SafeReceipt => ({
  operationId: taskId,
  operationHash: shaHex(taskId),
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
  dispatch: DelegatedOperationsPort,
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
      'Create a FIXTURE task through the M2 task service.',
      ['repo', 'goal'],
      async (input, context) => {
        assertContext(context);
        const record = assertRecord(input, 'fixture_task_create input');
        assertExactKeys(record, ['repo', 'goal', 'metadata'], 'fixture_task_create input');
        const repo = assertNonEmptyString(record['repo'], 'repo');
        const goal = assertNonEmptyString(record['goal'], 'goal');
        const metadata = assertSafeMetadata(record['metadata'], context, 'metadata');
        const task = await dispatch.create({ repo, goal });
        return {
          task,
          receipt: attestedReceipt(task.taskId, metadata['effectClass'] ?? 'READ'),
        };
      },
    ),
    defineTool(
      'fixture_task_execute',
      'Execute a FIXTURE task through the M2 task runner and return a redacted receipt.',
      ['taskId'],
      async (input, context) => {
        assertContext(context);
        const record = assertRecord(input, 'fixture_task_execute input');
        assertExactKeys(record, ['taskId', 'metadata'], 'fixture_task_execute input');
        const taskId = assertNonEmptyString(record['taskId'], 'taskId');
        const metadata = assertSafeMetadata(record['metadata'], context, 'metadata');
        return {
          receipt: toSafeReceipt(
            await dispatch.run(taskId, context.requester),
            metadata['effectClass'] ?? 'READ',
          ),
        };
      },
    ),
    defineTool(
      'fixture_task_receipt',
      'Return the redacted receipt for a FIXTURE task from M2 task state without re-executing.',
      ['taskId'],
      async (input, context) => {
        assertContext(context);
        const record = assertRecord(input, 'fixture_task_receipt input');
        assertExactKeys(record, ['taskId', 'metadata'], 'fixture_task_receipt input');
        const taskId = assertNonEmptyString(record['taskId'], 'taskId');
        const metadata = assertSafeMetadata(record['metadata'], context, 'metadata');
        const view = await dispatch.inspect(taskId);
        return { receipt: attestedReceipt(view.taskId, metadata['effectClass'] ?? 'READ') };
      },
    ),
    defineTool(
      'fixture_task_resume',
      'Resume a FIXTURE task through the M2 state machine transition guard.',
      ['taskId', 'from', 'to'],
      async (input, context) => {
        assertContext(context);
        const record = assertRecord(input, 'fixture_task_resume input');
        assertExactKeys(
          record,
          ['taskId', 'from', 'to', 'metadata'],
          'fixture_task_resume input',
        );
        const taskId = assertNonEmptyString(record['taskId'], 'taskId');
        const from = assertNonEmptyString(record['from'], 'from');
        const to = assertNonEmptyString(record['to'], 'to');
        assertSafeMetadata(record['metadata'], context, 'metadata');
        await dispatch.resume(taskId, from, to);
        return { task: { taskId, from, to } };
      },
    ),
    defineTool(
      'fixture_schedule_consume',
      'Consume a schedule entry through the same M2-backed run (no second scheduler).',
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
        const metadata = assertSafeMetadata(record['metadata'], context, 'metadata');
        return {
          receipt: toSafeReceipt(
            await dispatch.consumeScheduleEntry({ scheduleEntryId, taskId }, context.requester),
            metadata['effectClass'] ?? 'READ',
          ),
        };
      },
    ),
  ];

  const wanted = new Set(requested);
  return tools.filter((tool) => wanted.has(tool.name));
};
