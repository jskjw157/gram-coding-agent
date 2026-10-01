import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  ApprovalDecisionInput,
  ApprovalListInput,
  createApprovalApproveHandler,
  createApprovalDenyHandler,
  createApprovalListHandler,
  registerApprovalTools,
} from './approval-tools.js';

const TASK_ID = '018f0000-0000-7000-8000-000000000001';
const APPROVAL_ID = '0199aaaa-0000-7000-8000-0000000000aa';
const OPERATION_HASH = 'a'.repeat(64);

type Handler = (input: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

interface Registration {
  description: string;
  inputSchema: unknown;
}

class CapturingServer {
  readonly handlers = new Map<string, Handler>();
  readonly definitions = new Map<string, Registration>();

  registerTool(
    name: string,
    definition: Registration,
    handler: Handler,
  ): void {
    this.handlers.set(name, handler);
    this.definitions.set(name, definition);
  }
}

function asServer(server: CapturingServer): McpServer {
  return server as unknown as McpServer;
}

function handler(server: CapturingServer, name: string): Handler {
  const value = server.handlers.get(name);
  if (value === undefined) throw new Error('missing tool handler: ' + name);
  return value;
}

describe('T4 approval MCP tools', () => {
  it('A1: approval_list delegates the taskId and returns sanitized JSON', async () => {
    const approvals = [
      {
        id: APPROVAL_ID,
        taskId: TASK_ID,
        operationHash: OPERATION_HASH,
        status: 'PENDING',
      },
    ];
    const list = vi.fn(async (_taskId: string) => approvals);
    const handle = createApprovalListHandler({
      list,
      approve: vi.fn(),
      deny: vi.fn(),
    });

    const result = await handle({ taskId: TASK_ID });

    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(TASK_ID);
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify(approvals) },
    ]);
  });

  it('A2: approval_approve forwards approvalId and expected operationHash verbatim', async () => {
    const view = { id: APPROVAL_ID, status: 'APPROVED' };
    const approve = vi.fn(
      async (_approvalId: string, _operationHash: string) => view,
    );
    const handle = createApprovalApproveHandler({
      list: vi.fn(),
      approve,
      deny: vi.fn(),
    });

    const result = await handle({
      approvalId: APPROVAL_ID,
      operationHash: OPERATION_HASH,
    });

    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledWith(APPROVAL_ID, OPERATION_HASH);
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify(view) },
    ]);
  });

  it('A3: approval_deny forwards approvalId and expected operationHash verbatim', async () => {
    const view = { id: APPROVAL_ID, status: 'DENIED' };
    const deny = vi.fn(
      async (_approvalId: string, _operationHash: string) => view,
    );
    const handle = createApprovalDenyHandler({
      list: vi.fn(),
      approve: vi.fn(),
      deny,
    });

    const result = await handle({
      approvalId: APPROVAL_ID,
      operationHash: OPERATION_HASH,
    });

    expect(deny).toHaveBeenCalledTimes(1);
    expect(deny).toHaveBeenCalledWith(APPROVAL_ID, OPERATION_HASH);
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify(view) },
    ]);
  });

  it('A4: approval_approve lets a port rejection propagate instead of returning an error object', async () => {
    const approve = vi.fn(async () => {
      throw new Error('approval already resolved');
    });
    const handle = createApprovalApproveHandler({
      list: vi.fn(),
      approve,
      deny: vi.fn(),
    });

    await expect(
      handle({ approvalId: APPROVAL_ID, operationHash: OPERATION_HASH }),
    ).rejects.toThrow('approval already resolved');
  });

  it('A5: approval_deny lets a port rejection propagate instead of returning an error object', async () => {
    const deny = vi.fn(async () => {
      throw new Error('approval operation hash mismatch');
    });
    const handle = createApprovalDenyHandler({
      list: vi.fn(),
      approve: vi.fn(),
      deny,
    });

    await expect(
      handle({ approvalId: APPROVAL_ID, operationHash: OPERATION_HASH }),
    ).rejects.toThrow('approval operation hash mismatch');
  });

  it('A6: unknown/extra input keys are rejected by the strict schemas', () => {
    // The MCP SDK validates input against these schemas before invoking the
    // handler, so a failed safeParse means the handler is never reached.
    expect(
      ApprovalListInput.safeParse({ taskId: TASK_ID, unexpected: true })
        .success,
    ).toBe(false);
    expect(
      ApprovalDecisionInput.safeParse({
        approvalId: APPROVAL_ID,
        operationHash: OPERATION_HASH,
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  it('A7: malformed operationHash values are rejected before the port is called', () => {
    const valid = {
      approvalId: APPROVAL_ID,
      operationHash: OPERATION_HASH,
    };
    expect(ApprovalDecisionInput.safeParse(valid).success).toBe(true);

    const malformed = [
      'abc',
      'a'.repeat(63),
      'a'.repeat(65),
      'A'.repeat(64),
      'z'.repeat(64),
      ' '.repeat(64),
    ];
    for (const operationHash of malformed) {
      expect(
        ApprovalDecisionInput.safeParse({ approvalId: APPROVAL_ID, operationHash })
          .success,
      ).toBe(false);
    }
  });

  it('A8: approval_list output keeps hex operationHash readable but redacts sensitive-looking keys', async () => {
    const list = vi.fn(async (_taskId: string) => [
      {
        id: APPROVAL_ID,
        taskId: TASK_ID,
        operationHash: OPERATION_HASH,
        status: 'PENDING',
        token: 'plain-value-that-must-not-leak',
      },
    ]);
    const handle = createApprovalListHandler({
      list,
      approve: vi.fn(),
      deny: vi.fn(),
    });

    const result = await handle({ taskId: TASK_ID });
    const text = result.content[0]?.text ?? '';
    const parsed = JSON.parse(text) as Array<Record<string, unknown>>;

    expect(parsed[0]?.['operationHash']).toBe(OPERATION_HASH);
    expect(parsed[0]?.['token']).toBe('***REDACTED***');
    expect(text).not.toContain('plain-value-that-must-not-leak');
  });

  it('A9: all three tools are registered with a description and a schema', () => {
    const server = new CapturingServer();
    registerApprovalTools(asServer(server), {
      list: vi.fn(),
      approve: vi.fn(),
      deny: vi.fn(),
    });

    for (const name of ['approval_list', 'approval_approve', 'approval_deny'] as const) {
      const definition = server.definitions.get(name);
      expect(definition, name + ' must be registered').toBeDefined();
      expect(definition?.description.length).toBeGreaterThan(0);
      expect(definition?.inputSchema).toBeDefined();
    }
    expect(handler(server, 'approval_list')).toBeDefined();
    expect(handler(server, 'approval_approve')).toBeDefined();
    expect(handler(server, 'approval_deny')).toBeDefined();
  });

  it('A10: the tool layer imports nothing from persistence, policy, shell, or apps', () => {
    const source = readFileSync(
      new URL('./approval-tools.ts', import.meta.url),
      'utf8',
    );
    const specifiers = source
      .split('\n')
      .filter((line) => line.includes(' from '))
      .map((line) => line.trim());
    expect(specifiers.length).toBeGreaterThan(0);
    for (const line of specifiers) {
      expect(line).toMatch(/from ['"](@modelcontextprotocol\/server|zod|\.\/read-sanitizer\.js)['"]/);
    }
  });
});
