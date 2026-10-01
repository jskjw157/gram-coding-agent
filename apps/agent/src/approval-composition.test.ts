import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskId } from '@gram/domain';
import type { ApprovalToolsPort } from '@gram/mcp';
import {
  ApprovalRepository,
  openDatabase,
  runMigrations,
  TaskRepository,
  type StoredApproval,
} from '@gram/persistence';
import { PolicyEngine } from '@gram/policy';
import {
  ApprovalRequiredError,
  CommandRunner,
  PolicyDeniedError,
  type ApprovalConsumptionPort,
  type CommandOutputCapturePort,
  type CommandRunStore,
  type ProcessSpawner,
} from '@gram/shell';
import { createApprovalConsumptionPort, createApprovalToolsPort } from './main.js';

const NEEDS_APPROVAL_COMMAND = 'git reset --hard HEAD~1';
const ALLOW_COMMAND = 'git status';
const DENY_COMMAND = 'rm -rf /';

const databases: Array<{ close(): void }> = [];
const tempHomes: string[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
  while (tempHomes.length > 0) {
    const home = tempHomes.pop();
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  }
});

interface ApprovalHarness {
  taskId: TaskId;
  approvals: ApprovalRepository;
  consume: ApprovalConsumptionPort;
  tools: ApprovalToolsPort;
  runner: CommandRunner;
  spawn: ProcessSpawner['spawn'];
  consumeCalls: Array<{ taskId: string; operationHash: string }>;
}

function setupHarness(): ApprovalHarness {
  const db = openDatabase(':memory:');
  databases.push(db);
  runMigrations(db);
  const task = new TaskRepository(db).create({
    goal: 'T6 approval wiring',
    taskType: 'CODING',
    publishMode: 'PULL_REQUEST',
  });
  const approvals = new ApprovalRepository(db);
  const consumeCalls: Array<{ taskId: string; operationHash: string }> = [];
  const inner = createApprovalConsumptionPort(approvals);
  const consume: ApprovalConsumptionPort = {
    consume: async (taskId, operationHash) => {
      consumeCalls.push({ taskId, operationHash });
      return inner.consume(taskId, operationHash);
    },
  };
  const tools = createApprovalToolsPort(approvals);
  const spawn: ProcessSpawner['spawn'] = vi.fn(async () => ({
    exitCode: 0,
    stdout: 'ok',
    stderr: '',
  }));
  const commandRuns: CommandRunStore = {
    start: vi.fn(() => 1),
    finish: vi.fn(),
  };
  const outputCapture: CommandOutputCapturePort = {
    redactText: (text: string): string => text,
    capture: async (input: {
      taskId: string;
      commandRunId: number;
      stdout: string;
      stderr: string;
    }) => ({
      stdout: input.stdout,
      stderr: input.stderr,
      stdoutPath: '/tmp/stdout',
      stderrPath: '/tmp/stderr',
    }),
  };
  const homeDir = mkdtempSync(join(tmpdir(), 'gram-approval-home-'));
  tempHomes.push(homeDir);
  const runner = new CommandRunner({
    policy: new PolicyEngine(),
    approvals: consume,
    spawner: { spawn },
    commandRuns,
    outputCapture,
    homeDir,
    environment: { PATH: '/usr/bin', HOME: '/tmp', LANG: 'C.UTF-8' },
  });
  return { taskId: task.id, approvals, consume, tools, runner, spawn, consumeCalls };
}

function pendingRow(harness: ApprovalHarness): StoredApproval {
  const rows = harness.approvals.listForTask(harness.taskId);
  if (rows.length !== 1) throw new Error(`expected exactly one approval row, saw ${rows.length}`);
  const row = rows[0];
  if (row === undefined) throw new Error('expected a pending approval row');
  return row;
}

describe('T6 agent approval composition', () => {
  it('C1 blocks a NEEDS_APPROVAL attempt with no prior request and records a PENDING approval', async () => {
    const harness = setupHarness();

    const error = await harness.runner
      .run({ taskId: harness.taskId, cwd: process.cwd(), category: 'DEVELOPMENT', shellText: NEEDS_APPROVAL_COMMAND })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApprovalRequiredError);
    expect(harness.spawn).not.toHaveBeenCalled();
    const row = pendingRow(harness);
    expect(row.status).toBe('PENDING');
    expect(row.operationHash).toMatch(/^[0-9a-f]{64}$/);
    expect(harness.consumeCalls).toHaveLength(1);
    expect(harness.consumeCalls[0]?.taskId).toBe(harness.taskId);
    expect(harness.consumeCalls[0]?.operationHash).toBe(row.operationHash);
  });

  it('C2 allows the retry after the MCP port approves the pending request and spawns exactly once', async () => {
    const harness = setupHarness();
    const attempt = {
      taskId: harness.taskId,
      cwd: process.cwd(),
      category: 'DEVELOPMENT' as const,
      shellText: NEEDS_APPROVAL_COMMAND,
    };

    await expect(harness.runner.run(attempt)).rejects.toThrow(ApprovalRequiredError);
    const listed = (await harness.tools.list(harness.taskId)) as StoredApproval[];
    if (listed.length !== 1 || listed[0] === undefined) throw new Error('expected one pending approval');
    const approved = (await harness.tools.approve(
      String(listed[0].id),
      listed[0].operationHash,
    )) as StoredApproval;
    expect(approved.status).toBe('APPROVED');

    const result = await harness.runner.run(attempt);

    expect(result.exitCode).toBe(0);
    expect(harness.spawn).toHaveBeenCalledTimes(1);
  });

  it('C3 blocks a third retry after the approval was consumed — single-use', async () => {
    const harness = setupHarness();
    const attempt = {
      taskId: harness.taskId,
      cwd: process.cwd(),
      category: 'DEVELOPMENT' as const,
      shellText: NEEDS_APPROVAL_COMMAND,
    };

    await expect(harness.runner.run(attempt)).rejects.toThrow(ApprovalRequiredError);
    const listed = (await harness.tools.list(harness.taskId)) as StoredApproval[];
    if (listed.length !== 1 || listed[0] === undefined) throw new Error('expected one pending approval');
    await harness.tools.approve(String(listed[0].id), listed[0].operationHash);
    await harness.runner.run(attempt);

    await expect(harness.runner.run(attempt)).rejects.toThrow(ApprovalRequiredError);
    expect(harness.spawn).toHaveBeenCalledTimes(1);
  });

  it('C4 creates exactly one PENDING row across two blocked attempts for the same operation', async () => {
    const harness = setupHarness();
    const attempt = {
      taskId: harness.taskId,
      cwd: process.cwd(),
      category: 'DEVELOPMENT' as const,
      shellText: NEEDS_APPROVAL_COMMAND,
    };

    await expect(harness.runner.run(attempt)).rejects.toThrow(ApprovalRequiredError);
    await expect(harness.runner.run(attempt)).rejects.toThrow(ApprovalRequiredError);

    const rows = harness.approvals.listForTask(harness.taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('PENDING');
  });

  it('C5 never consumes and never creates an approval row for an ALLOW command', async () => {
    const harness = setupHarness();

    const result = await harness.runner.run({
      taskId: harness.taskId,
      cwd: process.cwd(),
      category: 'DEVELOPMENT',
      shellText: ALLOW_COMMAND,
    });

    expect(result.exitCode).toBe(0);
    expect(harness.spawn).toHaveBeenCalledTimes(1);
    expect(harness.consumeCalls).toHaveLength(0);
    expect(harness.approvals.listForTask(harness.taskId)).toHaveLength(0);
  });

  it('C6 never consumes and never spawns for a DENY command', async () => {
    const harness = setupHarness();

    await expect(
      harness.runner.run({
        taskId: harness.taskId,
        cwd: process.cwd(),
        category: 'DEVELOPMENT',
        shellText: DENY_COMMAND,
      }),
    ).rejects.toThrow(PolicyDeniedError);
    expect(harness.consumeCalls).toHaveLength(0);
    expect(harness.spawn).not.toHaveBeenCalled();
    expect(harness.approvals.listForTask(harness.taskId)).toHaveLength(0);
  });

  it('C8 stays fail-closed: NEEDS_APPROVAL with no approval available is refused, never auto-approved', async () => {
    const harness = setupHarness();

    expect(await harness.consume.consume(harness.taskId, 'f'.repeat(64))).toBe(false);
    await expect(
      harness.runner.run({
        taskId: harness.taskId,
        cwd: process.cwd(),
        category: 'DEVELOPMENT',
        shellText: NEEDS_APPROVAL_COMMAND,
      }),
    ).rejects.toThrow(ApprovalRequiredError);
    expect(harness.spawn).not.toHaveBeenCalled();
  });
});
