import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMcpHttpServer,
  type CreateMcpHttpServerOptions,
  type RunningMcpServer,
} from './server.js';
import type { ApprovalToolsPort } from './tools/approval-tools.js';

const running: RunningMcpServer[] = [];

const TASK_ID = '018f0000-0000-7000-8000-000000000001';
const APPROVAL_ID = '0199aaaa-0000-7000-8000-0000000000aa';
const OPERATION_HASH = 'a'.repeat(64);

const APPROVAL_TOOL_NAMES = [
  'approval_list',
  'approval_approve',
  'approval_deny',
] as const;

const PRE_EXISTING_TOOL_NAMES = [
  'task_create',
  'task_get',
  'task_list',
  'task_logs',
  'task_result',
  'repo_resolve',
  'repo_list',
  'repo_get',
  'repo_inspect',
  'repo_register',
  'code_search',
  'file_read',
  'file_write',
  'file_patch',
  'file_diff',
  'git_status',
  'git_diff',
  'git_log',
  'git_blame',
  'verification_plan',
  'verification_run',
  'verification_status',
  'verification_evidence',
  'verification_review_get',
  'verification_review_read',
  'verification_review_submit',
  'verification_review_fail',
  'coding_step_get',
  'coding_step_read',
  'coding_step_submit',
  'coding_step_fail',
  'github_pr_ensure',
  'github_pr_get',
  'github_pr_checks',
  'agent_status',
  'agent_health',
  'agent_logs',
] as const;

type OptionsWithApprovals = CreateMcpHttpServerOptions & {
  approvals?: ApprovalToolsPort;
};

function probe(url: string, secret?: string): Promise<Response> {
  return fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(secret === undefined ? {} : { 'x-gram-agent-auth': secret }),
    },
    body: '{}',
  });
}

function approvalPort() {
  return {
    list: vi.fn(async () => []),
    approve: vi.fn(async () => ({ id: APPROVAL_ID, status: 'APPROVED' })),
    deny: vi.fn(async () => ({ id: APPROVAL_ID, status: 'DENIED' })),
  };
}

function fullOptions(secret: string): OptionsWithApprovals {
  return {
    host: '127.0.0.1',
    port: 0,
    internalSecret: secret,
    taskCreate: { create: vi.fn() },
    codingCapability: {
      get: vi.fn(),
      read: vi.fn(),
      submit: vi.fn(),
      fail: vi.fn(),
    },
    verificationReviews: {
      get: vi.fn(),
      read: vi.fn(),
      submit: vi.fn(),
      fail: vi.fn(),
    },
    taskRead: { get: vi.fn(), list: vi.fn(), logs: vi.fn(), result: vi.fn() },
    repos: {
      resolve: vi.fn(),
      list: vi.fn(),
      get: vi.fn(),
      inspect: vi.fn(),
      register: vi.fn(),
    },
    codeTools: {
      search: vi.fn(),
      readText: vi.fn(),
      writeText: vi.fn(),
      patchExact: vi.fn(),
      diff: vi.fn(),
    },
    gitTools: { status: vi.fn(), diff: vi.fn(), log: vi.fn(), blame: vi.fn() },
    verificationTools: {
      plan: vi.fn(),
      run: vi.fn(),
      status: vi.fn(),
      evidence: vi.fn(),
    },
    githubPullRequests: { ensure: vi.fn() },
    githubRead: { getPullRequest: vi.fn(), checks: vi.fn() },
    agentTools: { status: vi.fn(), health: vi.fn(), logs: vi.fn() },
  };
}

interface RpcEnvelope {
  result: unknown;
}

interface ToolsListResult {
  tools: Array<{ name: string }>;
}

interface ToolsCallResult {
  content: Array<{ text: string }>;
}

// server.test.ts previously could not list tools: probe() posts an
// invalid body ('{}' -> 400) which never reaches the server factory.
// A legacy initialize followed by tools/list IS served over the wire
// (stateless fallback, one factory instance per request), so advertised
// tools are asserted over real MCP here.
async function rpc(
  url: string,
  secret: string,
  method: string,
  params: unknown,
  id: number,
): Promise<RpcEnvelope> {
  const res = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-gram-agent-auth': secret,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  const dataLine = text
    .split('\n')
    .find((line) => line.startsWith('data: '));
  if (dataLine === undefined) throw new Error('missing SSE data frame');
  return JSON.parse(dataLine.slice('data: '.length)) as RpcEnvelope;
}

async function advertisedNames(
  options: OptionsWithApprovals,
): Promise<string[]> {
  const server = await createMcpHttpServer(options);
  running.push(server);
  await rpc(
    server.url,
    options.internalSecret,
    'initialize',
    {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 't', version: '0' },
    },
    1,
  );
  const list = (await rpc(server.url, options.internalSecret, 'tools/list', {}, 2))
    .result as ToolsListResult;
  return list.tools.map((tool) => tool.name);
}

afterEach(async () => {
  while (running.length) await running.pop()?.close();
});

describe('authenticated loopback MCP server', () => {
  it('rejects non-loopback bind addresses', async () => {
    await expect(
      createMcpHttpServer({ host: '0.0.0.0', port: 0, internalSecret: 'test-secret' }),
    ).rejects.toThrow(/loopback/i);
  });

  it('rejects missing and incorrect credentials before MCP dispatch', async () => {
    const server = await createMcpHttpServer({
      host: '127.0.0.1',
      port: 0,
      internalSecret: 'correct-secret',
    });
    running.push(server);

    expect((await probe(server.url)).status).toBe(401);
    expect((await probe(server.url, 'wrong-secret')).status).toBe(401);
    expect((await probe(server.url, 'correct-secret')).status).not.toBe(401);
  });
});

describe('T5 approval tool wiring', () => {
  it('M1: advertises all three approval tools when the approval port is provided', async () => {
    const names = await advertisedNames({
      ...fullOptions('s1-secret'),
      approvals: approvalPort(),
    });

    for (const name of APPROVAL_TOOL_NAMES) {
      expect(names).toContain(name);
    }
  });

  it('M2: advertises none of the approval tools when the approval port is omitted', async () => {
    const names = await advertisedNames(fullOptions('s2-secret'));

    for (const name of APPROVAL_TOOL_NAMES) {
      expect(names).not.toContain(name);
    }
  });

  it('M3: still rejects unauthenticated requests when the approval port is wired', async () => {
    const server = await createMcpHttpServer({
      ...fullOptions('correct-secret'),
      approvals: approvalPort(),
    });
    running.push(server);

    expect((await probe(server.url)).status).toBe(401);
    expect((await probe(server.url, 'wrong-secret')).status).toBe(401);
  });

  it('M4: every pre-existing tool still advertises exactly as before', async () => {
    const names = await advertisedNames({
      ...fullOptions('s4-secret'),
      approvals: approvalPort(),
    });

    for (const name of PRE_EXISTING_TOOL_NAMES) {
      expect(names).toContain(name);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it('M5: the approval port receives no credential and invocation flows purely through the port', async () => {
    const port = approvalPort();
    const server = await createMcpHttpServer({
      ...fullOptions('s5-secret'),
      approvals: port,
    });
    running.push(server);
    await rpc(
      server.url,
      's5-secret',
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 't', version: '0' },
      },
      1,
    );

    const listCall = (
      await rpc(
        server.url,
        's5-secret',
        'tools/call',
        { name: 'approval_list', arguments: { taskId: TASK_ID } },
        2,
      )
    ).result as ToolsCallResult;
    expect(port.list).toHaveBeenCalledTimes(1);
    expect(port.list).toHaveBeenCalledWith(TASK_ID);
    const listText = listCall.content[0]?.text;
    expect(listText).toBeDefined();
    expect(JSON.parse(listText ?? '')).toEqual([]);

    const approveCall = (
      await rpc(
        server.url,
        's5-secret',
        'tools/call',
        {
          name: 'approval_approve',
          arguments: { approvalId: APPROVAL_ID, operationHash: OPERATION_HASH },
        },
        3,
      )
    ).result as ToolsCallResult;
    expect(port.approve).toHaveBeenCalledTimes(1);
    expect(port.approve).toHaveBeenCalledWith(APPROVAL_ID, OPERATION_HASH);
    const approveText = approveCall.content[0]?.text;
    expect(approveText).toBeDefined();
    expect(JSON.parse(approveText ?? '')).toEqual({
      id: APPROVAL_ID,
      status: 'APPROVED',
    });

    expect(Object.keys(port).sort()).toEqual(['approve', 'deny', 'list']);
    expect(JSON.stringify(port)).not.toContain('s5-secret');
  });
});
