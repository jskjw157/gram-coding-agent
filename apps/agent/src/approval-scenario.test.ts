import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMcpHttpServer, type RunningMcpServer } from '@gram/mcp';
import {
  ApprovalRepository,
  openDatabase,
  runMigrations,
  TaskRepository,
  type StoredApproval,
} from '@gram/persistence';
import { PolicyEngine } from '@gram/policy';
import { ApprovalRequiredError, CommandRunner } from '@gram/shell';
import { createApprovalConsumptionPort, createApprovalToolsPort } from './main.js';

// Cross-boundary regression gate for issue #151. Every scenario below drives
// the REAL components against ONE real file-backed SQLite database: the real
// PolicyEngine + CommandRunner + createApprovalConsumptionPort composition,
// the real ApprovalRepository, and the real MCP server over the wire
// (authenticated tools/call — never a direct handler call).
const NEEDS_APPROVAL_COMMAND = 'git reset --hard HEAD~1';
const SECRET = 'scenario-secret';
const PAST_INSTANT = '2000-01-01T00:00:00.000Z';

const databases: Array<{ close(): void }> = [];
const tempDirs: string[] = [];
const servers: RunningMcpServer[] = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
  while (databases.length > 0) databases.pop()?.close();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

interface Scenario {
  dir: string;
  db: ReturnType<typeof openDatabase>;
  taskId: string;
  approvals: ApprovalRepository;
  runner: CommandRunner;
  spawn: ReturnType<typeof vi.fn>;
}

function setupScenario(): Scenario {
  const dir = mkdtempSync(join(tmpdir(), 'gram-approval-scenario-'));
  tempDirs.push(dir);
  const db = openDatabase(join(dir, 'agent.sqlite'));
  databases.push(db);
  runMigrations(db);
  const taskId = new TaskRepository(db).create({
    goal: 'approval scenario gate',
    taskType: 'CODING',
    publishMode: 'PULL_REQUEST',
  }).id;
  const approvals = new ApprovalRepository(db);
  const spawn = vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }));
  const runner = new CommandRunner({
    policy: new PolicyEngine(),
    approvals: createApprovalConsumptionPort(approvals),
    spawner: { spawn },
    commandRuns: { start: vi.fn(() => 1), finish: vi.fn() },
    outputCapture: {
      redactText: (text: string): string => text,
      capture: async (input: { taskId: string; commandRunId: number; stdout: string; stderr: string }) => ({
        stdout: input.stdout,
        stderr: input.stderr,
        stdoutPath: '/tmp/stdout',
        stderrPath: '/tmp/stderr',
      }),
    },
  });
  return { dir, db, taskId, approvals, runner, spawn };
}

function attempt(taskId: string) {
  return { taskId, cwd: process.cwd(), category: 'DEVELOPMENT' as const, shellText: NEEDS_APPROVAL_COMMAND };
}

async function startWireServer(scenario: Scenario): Promise<RunningMcpServer> {
  const server = await createMcpHttpServer({
    host: '127.0.0.1',
    port: 0,
    internalSecret: SECRET,
    approvals: createApprovalToolsPort(scenario.approvals),
  });
  servers.push(server);
  return server;
}

interface RpcEnvelope {
  result: unknown;
}

interface RpcRequest {
  readonly method: string;
  readonly params: unknown;
  readonly id: number;
}

interface ToolCall {
  readonly name: string;
  readonly args: unknown;
  readonly id: number;
}

async function rpc(url: string, request: RpcRequest): Promise<unknown> {
  const res = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-gram-agent-auth': SECRET,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: request.id, method: request.method, params: request.params }),
  });
  expect(res.status).toBe(200);
  const frame = (await res.text()).split('\n').find((line) => line.startsWith('data: '));
  if (frame === undefined) throw new Error('missing SSE data frame');
  return ((JSON.parse(frame.slice('data: '.length)) as RpcEnvelope).result);
}

async function callTool(url: string, call: ToolCall): Promise<unknown> {
  await rpc(url, { method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } }, id: call.id * 10 });
  const result = (await rpc(url, { method: 'tools/call', params: { name: call.name, arguments: call.args }, id: call.id * 10 + 1 })) as {
    content: Array<{ text: string }>;
  };
  const text = result.content[0]?.text;
  if (text === undefined) throw new Error(`tool ${call.name} returned no text content`);
  const parsed: unknown = JSON.parse(text);
  return parsed;
}

function onlyRow(scenario: Scenario): StoredApproval {
  const rows = scenario.approvals.listForTask(scenario.taskId);
  if (rows.length !== 1 || rows[0] === undefined) throw new Error(`expected one approval row, saw ${rows.length}`);
  return rows[0];
}

describe('approval cross-boundary scenario gate', () => {
  it('unblocks over the wire, spawns exactly once, then refuses reuse (single-use)', async () => {
    const scenario = setupScenario();
    const server = await startWireServer(scenario);
    await expect(scenario.runner.run(attempt(scenario.taskId))).rejects.toThrow(ApprovalRequiredError);
    expect(scenario.spawn).not.toHaveBeenCalled();
    const pending = onlyRow(scenario);
    expect(pending.status).toBe('PENDING');
    expect(pending.operationHash).toMatch(/^[0-9a-f]{64}$/);
    // Scenario 6 (same shared Database): the row written through the
    // repository is visible through the raw handle — no second connection.
    const raw = scenario.db.prepare('SELECT COUNT(*) AS n FROM approvals WHERE task_id = ?').get(scenario.taskId) as { n: number };
    expect(raw.n).toBe(scenario.approvals.listForTask(scenario.taskId).length);
    const listed = (await callTool(server.url, { name: 'approval_list', args: { taskId: scenario.taskId }, id: 1 })) as StoredApproval[];
    expect(listed).toHaveLength(1);
    const approved = (await callTool(server.url, { name: 'approval_approve', args: { approvalId: String(pending.id), operationHash: pending.operationHash }, id: 2 })) as StoredApproval;
    expect(approved.status).toBe('APPROVED');
    const result = await scenario.runner.run(attempt(scenario.taskId));
    expect(result.exitCode).toBe(0);
    expect(scenario.spawn).toHaveBeenCalledTimes(1);
    expect(scenario.approvals.get(pending.id)?.status).toBe('CONSUMED');
    await expect(scenario.runner.run(attempt(scenario.taskId))).rejects.toThrow(ApprovalRequiredError);
    expect(scenario.spawn).toHaveBeenCalledTimes(1);
  });

  it('denies through the MCP surface and never authorises the command', async () => {
    const scenario = setupScenario();
    const server = await startWireServer(scenario);
    await expect(scenario.runner.run(attempt(scenario.taskId))).rejects.toThrow(ApprovalRequiredError);
    const pending = onlyRow(scenario);
    const denied = (await callTool(server.url, { name: 'approval_deny', args: { approvalId: String(pending.id), operationHash: pending.operationHash }, id: 3 })) as StoredApproval;
    expect(denied.status).toBe('DENIED');
    await expect(scenario.runner.run(attempt(scenario.taskId))).rejects.toThrow(ApprovalRequiredError);
    expect(scenario.spawn).not.toHaveBeenCalled();
  });

  it('keeps approvals isolated across tasks', async () => {
    const scenario = setupScenario();
    const server = await startWireServer(scenario);
    const taskB = new TaskRepository(scenario.db).create({ goal: 'other task', taskType: 'CODING', publishMode: 'PULL_REQUEST' }).id;
    await expect(scenario.runner.run(attempt(scenario.taskId))).rejects.toThrow(ApprovalRequiredError);
    const pending = onlyRow(scenario);
    await callTool(server.url, { name: 'approval_approve', args: { approvalId: String(pending.id), operationHash: pending.operationHash }, id: 4 });
    await expect(scenario.runner.run(attempt(taskB))).rejects.toThrow(ApprovalRequiredError);
    expect(scenario.spawn).not.toHaveBeenCalled();
    expect(scenario.approvals.get(pending.id)?.status).toBe('APPROVED');
  });

  it('expires end to end, then allows a fresh request for the same pair', async () => {
    // Time control: directly backdate expires_at (the R7/R8 pattern). This is
    // honest, not a workaround: the repository owns "now" via Date with no
    // injectable clock, so rewriting the stored instant is the only way to
    // simulate TTL passage — and the lazy APPROVED-to-EXPIRED transition in
    // consume/request still runs for real instead of being skipped.
    const scenario = setupScenario();
    const server = await startWireServer(scenario);
    await expect(scenario.runner.run(attempt(scenario.taskId))).rejects.toThrow(ApprovalRequiredError);
    const pending = onlyRow(scenario);
    await callTool(server.url, { name: 'approval_approve', args: { approvalId: String(pending.id), operationHash: pending.operationHash }, id: 5 });
    scenario.db.prepare('UPDATE approvals SET expires_at = ? WHERE id = ?').run(PAST_INSTANT, pending.id);
    await expect(scenario.runner.run(attempt(scenario.taskId))).rejects.toThrow(ApprovalRequiredError);
    expect(scenario.spawn).not.toHaveBeenCalled();
    expect(scenario.approvals.get(pending.id)?.status).toBe('EXPIRED');
    const rows = scenario.approvals.listForTask(scenario.taskId);
    const fresh = rows.find((row) => row.id !== pending.id);
    expect(fresh?.status).toBe('PENDING');
    expect(fresh?.operationHash).toBe(pending.operationHash);
  });

  it('gates the control surface on auth and loopback', async () => {
    const scenario = setupScenario();
    const server = await startWireServer(scenario);
    const unauthenticated = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'approval_approve', arguments: { approvalId: '1', operationHash: 'a'.repeat(64) } } }),
    });
    expect(unauthenticated.status).toBe(401);
    await expect(createMcpHttpServer({ host: '0.0.0.0', port: 0, internalSecret: SECRET })).rejects.toThrow(/loopback/i);
  });

  it('never reflects caller-supplied approvalId in MCP error responses', async () => {
    const scenario = setupScenario();
    const server = await startWireServer(scenario);
    await expect(scenario.runner.run(attempt(scenario.taskId))).rejects.toThrow(ApprovalRequiredError);
    const pending = onlyRow(scenario);
    const operationHash = pending.operationHash;
    let nextId = 100;

    async function callRaw(tool: 'approval_approve' | 'approval_deny', approvalId: string): Promise<{ rawBody: string; result: { isError?: boolean; content?: Array<{ text?: string }> } }> {
      nextId += 1;
      const callId = nextId;
      await rpc(server.url, { method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } }, id: callId * 10 });
      const res = await fetch(`${server.url}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'x-gram-agent-auth': SECRET,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: callId * 10 + 1, method: 'tools/call', params: { name: tool, arguments: { approvalId, operationHash } } }),
      });
      expect(res.status).toBe(200);
      const rawBody = await res.text();
      const frame = rawBody.split('\n').find((line) => line.startsWith('data: '));
      if (frame === undefined) throw new Error(`tool ${tool} returned no SSE data frame`);
      const result = (JSON.parse(frame.slice('data: '.length)) as { result: { isError?: boolean; content?: Array<{ text?: string }> } }).result;
      return { rawBody, result };
    }

    const probes = [SECRET, 'sk-probe-secret-shaped-value-abc123'];
    for (const probe of probes) {
      for (const tool of ['approval_approve', 'approval_deny'] as const) {
        const { rawBody, result } = await callRaw(tool, probe);
        expect(rawBody).not.toContain(probe);
        expect(result.isError).toBe(true);
        const text = result.content?.[0]?.text ?? '';
        expect(text).not.toContain(probe);
        expect(text).toMatch(/positive decimal integer/i);
      }
    }

    const aliased = String(pending.id).padStart(4, '0');
    expect(aliased).not.toBe(String(pending.id));
    for (const tool of ['approval_approve', 'approval_deny'] as const) {
      const { rawBody, result } = await callRaw(tool, aliased);
      expect(result.isError).toBe(true);
      const text = result.content?.[0]?.text ?? '';
      expect(text).toMatch(/positive decimal integer/i);
      expect(rawBody).not.toContain(aliased);
    }

    const approved = (await callTool(server.url, { name: 'approval_approve', args: { approvalId: String(pending.id), operationHash }, id: 7 })) as StoredApproval;
    expect(approved.status).toBe('APPROVED');
    expect(scenario.approvals.get(pending.id)?.status).toBe('APPROVED');
  });
});
