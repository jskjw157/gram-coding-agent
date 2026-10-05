// operation-tools.test.ts — T10 repair: strict-schemed MCP operation tools
// delegating to the M2-backed dispatch (no standalone execution path).
// Redacted receipts, scope-sensitive SAFE FIELDS ONLY metadata, and
// delegation proofs (every handler reaches the dispatch port exactly once;
// receipt reads M2 state without executing).
import { describe, expect, it } from 'vitest';
import {
  SAFE_METADATA_FIELDS,
  UnsafeMetadataError,
  UnknownToolError,
  createFixtureOperationTools,
  type DelegatedOperationsPort,
  type ToolContext,
} from './operation-tools.js';

const dispatchPort = (): DelegatedOperationsPort & {
  creates: unknown[];
  runs: unknown[];
  inspects: string[];
  resumes: unknown[];
  consumes: unknown[];
} => {
  const creates: unknown[] = [];
  const runs: unknown[] = [];
  const inspects: string[] = [];
  const resumes: unknown[] = [];
  const consumes: unknown[] = [];
  return {
    creates,
    runs,
    inspects,
    resumes,
    consumes,
    create: async (input: { repo: string; goal: string }) => {
      creates.push(input);
      return {
        taskId: 'task-1',
        displayId: 'TASK-000001',
        repo: input.repo,
        goal: input.goal,
        status: 'QUEUED',
      };
    },
    run: async (taskId: string, requester: string) => {
      runs.push({ taskId, requester });
      return {
        operationId: taskId,
        operationHash: 'hash-delegated-m2-run',
        policyDecision: 'ALLOW',
        appliedAt: '2026-10-04T00:00:00.000Z',
      };
    },
    inspect: async (taskId: string) => {
      inspects.push(taskId);
      return {
        taskId,
        displayId: 'TASK-000001',
        repo: 'owner/repo',
        goal: 'goal-a',
        status: 'QUEUED',
      };
    },
    resume: async (taskId: string, from: string, to: string): Promise<void> => {
      resumes.push({ taskId, from, to });
    },
    consumeScheduleEntry: async (
      entry: { scheduleEntryId: string; taskId: string },
      requester: string,
    ) => {
      consumes.push({ entry, requester });
      return {
        operationId: entry.taskId,
        operationHash: 'hash-delegated-m2-run',
        policyDecision: 'ALLOW',
        appliedAt: '2026-10-04T00:00:00.000Z',
      };
    },
  };
};

const context = (overrides?: Partial<ToolContext>): ToolContext => ({
  requester: 'requester-a',
  scope: 'RESOURCE',
  ...overrides,
});

const tool = (port: DelegatedOperationsPort, name: string): ((input: unknown, context: ToolContext) => Promise<unknown>) => {
  const found = createFixtureOperationTools(port).find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`missing ${name}`);
  return found.handler;
};

describe('fixture operation tools', () => {
  it('exposes exactly the fixture task toolset', () => {
    const tools = createFixtureOperationTools(dispatchPort());
    expect(tools.map((entry) => entry.name)).toEqual([
      'fixture_task_create',
      'fixture_task_execute',
      'fixture_task_receipt',
      'fixture_task_resume',
      'fixture_schedule_consume',
    ]);
  });

  it('creates through the M2 task service and returns a redacted receipt', async () => {
    const port = dispatchPort();
    const created = (await tool(port, 'fixture_task_create')(
      {
        repo: 'owner/repo',
        goal: 'goal-a',
        metadata: { taskKind: 'QUERY', executionMode: 'FIXTURE', scope: 'RESOURCE' },
      },
      context(),
    )) as { task: { taskId: string }; receipt: Record<string, unknown> };
    expect(port.creates).toEqual([{ repo: 'owner/repo', goal: 'goal-a' }]);
    expect(created.task.taskId).toBe('task-1');
    expect(created.receipt).not.toHaveProperty('requester');
    expect(created.receipt).not.toHaveProperty('storeId');
    expect(created.receipt).not.toHaveProperty('accountId');
    expect(JSON.stringify(created.receipt)).not.toContain('requester-a');
  });

  it('executes through the M2 task runner as the calling requester', async () => {
    const port = dispatchPort();
    const result = (await tool(port, 'fixture_task_execute')(
      { taskId: 'task-1', metadata: { executionMode: 'FIXTURE', scope: 'RESOURCE' } },
      context(),
    )) as { receipt: Record<string, unknown> };
    expect(port.runs).toEqual([{ taskId: 'task-1', requester: 'requester-a' }]);
    expect(result.receipt['operationId']).toBe('task-1');
    expect(result.receipt['operationHash']).toBe('hash-delegated-m2-run');
    expect(JSON.stringify(result.receipt)).not.toContain('requester-a');
  });

  it('reads receipts from M2 task state without re-executing', async () => {
    const port = dispatchPort();
    const result = (await tool(port, 'fixture_task_receipt')(
      { taskId: 'task-1', metadata: { executionMode: 'FIXTURE', scope: 'RESOURCE' } },
      context(),
    )) as { receipt: Record<string, unknown> };
    expect(port.inspects).toEqual(['task-1']);
    expect(port.runs).toHaveLength(0);
    expect(result.receipt['operationId']).toBe('task-1');
  });

  it('resumes through the M2 state machine transition guard', async () => {
    const port = dispatchPort();
    const result = (await tool(port, 'fixture_task_resume')(
      {
        taskId: 'task-1',
        from: 'QUEUED',
        to: 'WAITING_REPO_LOCK',
        metadata: { executionMode: 'FIXTURE', scope: 'RESOURCE' },
      },
      context(),
    )) as { task: Record<string, unknown> };
    expect(port.resumes).toEqual([{ taskId: 'task-1', from: 'QUEUED', to: 'WAITING_REPO_LOCK' }]);
    expect(result.task).toEqual({ taskId: 'task-1', from: 'QUEUED', to: 'WAITING_REPO_LOCK' });
  });

  it('consumes schedule entries through the same M2-backed run', async () => {
    const port = dispatchPort();
    const result = (await tool(port, 'fixture_schedule_consume')(
      {
        scheduleEntryId: 'sched-1',
        taskId: 'task-1',
        metadata: { executionMode: 'FIXTURE', scope: 'RESOURCE' },
      },
      context(),
    )) as { receipt: Record<string, unknown> };
    expect(port.consumes).toEqual([
      { entry: { scheduleEntryId: 'sched-1', taskId: 'task-1' }, requester: 'requester-a' },
    ]);
    expect(result.receipt['operationId']).toBe('task-1');
  });

  it('rejects unknown tools', () => {
    expect(() => createFixtureOperationTools(dispatchPort(), ['nope_tool'])).toThrow(UnknownToolError);
  });

  it('rejects unsafe metadata fields (SAFE FIELDS ONLY)', async () => {
    const port = dispatchPort();
    await expect(
      tool(port, 'fixture_task_create')(
        {
          repo: 'owner/repo',
          goal: 'goal-a',
          metadata: { taskKind: 'QUERY', executionMode: 'FIXTURE', scope: 'RESOURCE', apiToken: 'x' },
        },
        context(),
      ),
    ).rejects.toThrow(UnsafeMetadataError);
    expect(port.creates).toHaveLength(0);
  });

  it('rejects scope mismatch between context and metadata', async () => {
    const port = dispatchPort();
    await expect(
      tool(port, 'fixture_task_execute')(
        { taskId: 'task-1', metadata: { scope: 'ACCOUNT' } },
        context({ scope: 'RESOURCE' }),
      ),
    ).rejects.toThrow(UnsafeMetadataError);
    expect(port.runs).toHaveLength(0);
  });

  it('publishes the safe metadata field allowlist', () => {
    expect([...SAFE_METADATA_FIELDS].sort()).toEqual(
      ['effectClass', 'executionMode', 'recipeId', 'scope', 'taskKind'].sort(),
    );
  });
});
