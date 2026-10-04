// operation-tools.test.ts — MAC-03 WP-12 RED: strict-schemed MCP operation tools
// (fixture task ops, redacted receipts, scope-sensitive SAFE FIELDS ONLY metadata).
import { describe, expect, it } from 'vitest';
import {
  SAFE_METADATA_FIELDS,
  UnsafeMetadataError,
  UnknownToolError,
  createFixtureOperationTools,
  type FixtureRunnerPort,
  type ToolContext,
} from './operation-tools.js';

const runnerPort = (): FixtureRunnerPort => {
  let sequence = 0;
  const checkpoints = new Map<string, string>();
  return {
    createTask: (input: { recipeId: string; requester: string }) => {
      sequence += 1;
      const taskId = `task-${sequence}`;
      checkpoints.set(taskId, `checkpoint-${taskId}`);
      return { taskId, recipeId: input.recipeId, checkpointDigest: `checkpoint-${taskId}` };
    },
    execute: (taskId: string) => ({
      operationId: taskId,
      operationHash: 'hash-internal-requester-requester-a-store-s1',
      effectClass: 'READ',
      policyDecision: 'ALLOW',
      appliedAt: '2026-10-04T00:00:00.000Z',
      artifacts: [],
      internal: { requester: 'requester-a', storeId: 's1', accountId: 'a1' },
    }),
    resume: (taskId: string) => ({ taskId, checkpointDigest: checkpoints.get(taskId) ?? '' }),
  };
};

const context = (overrides?: Partial<ToolContext>): ToolContext => ({
  requester: 'requester-a',
  scope: 'RESOURCE',
  ...overrides,
});

describe('fixture operation tools', () => {
  it('exposes exactly the fixture task toolset', () => {
    const tools = createFixtureOperationTools(runnerPort());
    expect(tools.map((tool) => tool.name)).toEqual([
      'fixture_task_create',
      'fixture_task_execute',
      'fixture_task_receipt',
      'fixture_task_resume',
      'fixture_schedule_consume',
    ]);
  });

  it('creates a task and returns a redacted receipt (no internal identity)', async () => {
    const tools = createFixtureOperationTools(runnerPort());
    const create = tools.find((tool) => tool.name === 'fixture_task_create');
    if (create === undefined) throw new Error('missing fixture_task_create');
    const created = (await create.handler(
      {
        recipeId: 'recipe-fixture-echo',
        metadata: { taskKind: 'QUERY', executionMode: 'FIXTURE', scope: 'RESOURCE' },
      },
      context(),
    )) as { receipt: Record<string, unknown> };
    expect(created.receipt['operationId']).toBe('task-1');
    expect(created.receipt).not.toHaveProperty('requester');
    expect(created.receipt).not.toHaveProperty('storeId');
    expect(created.receipt).not.toHaveProperty('accountId');
    expect(JSON.stringify(created.receipt)).not.toContain('requester-a');
  });

  it('rejects unknown tools', () => {
    expect(() => createFixtureOperationTools(runnerPort(), ['nope_tool'])).toThrow(UnknownToolError);
  });

  it('rejects unsafe metadata fields (SAFE FIELDS ONLY)', async () => {
    const tools = createFixtureOperationTools(runnerPort());
    const create = tools.find((tool) => tool.name === 'fixture_task_create');
    if (create === undefined) throw new Error('missing fixture_task_create');
    await expect(
      create.handler(
        {
          recipeId: 'recipe-fixture-echo',
          metadata: { taskKind: 'QUERY', executionMode: 'FIXTURE', scope: 'RESOURCE', apiToken: 'x' },
        },
        context(),
      ),
    ).rejects.toThrow(UnsafeMetadataError);
  });

  it('rejects scope mismatch between context and metadata', async () => {
    const tools = createFixtureOperationTools(runnerPort());
    const execute = tools.find((tool) => tool.name === 'fixture_task_execute');
    if (execute === undefined) throw new Error('missing fixture_task_execute');
    await expect(
      execute.handler(
        { taskId: 'task-1', metadata: { scope: 'ACCOUNT' } },
        context({ scope: 'RESOURCE' }),
      ),
    ).rejects.toThrow(UnsafeMetadataError);
  });

  it('publishes the safe metadata field allowlist', () => {
    expect([...SAFE_METADATA_FIELDS].sort()).toEqual(
      ['effectClass', 'executionMode', 'recipeId', 'scope', 'taskKind'].sort(),
    );
  });
});
