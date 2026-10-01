import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { registerTaskReadTools } from './task-tools.js';
import { registerVerificationTools } from './verification-tools.js';

type Handler = (input: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

class CapturingServer {
  readonly handlers = new Map<string, Handler>();

  registerTool(
    name: string,
    _definition: unknown,
    handler: Handler,
  ): void {
    this.handlers.set(name, handler);
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

describe('M2 task-scoped read authorization', () => {
  it('task_logs delegates only the selected task id and redacts credential material', async () => {
    const selected = '018f0000-0000-7000-8000-000000000001';
    const logs = vi.fn(async (taskId: string) => ({
      taskId,
      lines: [
        'normal line',
        'Authorization: Bearer github_pat_abcdefghijklmnopqrstuvwxyz',
      ],
      credential: {
        token: 'github_pat_abcdefghijklmnopqrstuvwxyz',
        secretPath: '/home/user/.gram-agent/secrets/github-token',
      },
    }));
    const server = new CapturingServer();

    registerTaskReadTools(asServer(server), {
      get: vi.fn(),
      list: vi.fn(),
      logs,
      result: vi.fn(),
    });

    const response = await handler(server, 'task_logs')({ taskId: selected });
    const text = response.content[0]?.text ?? '';

    expect(logs).toHaveBeenCalledTimes(1);
    expect(logs).toHaveBeenCalledWith(selected);
    expect(text).toContain(selected);
    expect(text).toContain('normal line');
    expect(text).not.toContain('github_pat_abcdefghijklmnopqrstuvwxyz');
    expect(text).not.toContain('/home/user/.gram-agent/secrets/github-token');
  });

  it('verification_evidence delegates only the selected task and redacts raw credentials', async () => {
    const selected = '018f0000-0000-7000-8000-000000000002';
    const evidence = vi.fn(async (taskId: string) => ({
      taskId,
      checks: [{ name: 'test', status: 'PASS', evidenceRef: 'cmd:77' }],
      rawCredentialMetadata: {
        authorization: 'Bearer sk-proj-abcdefghijklmnopqrstuvwxyz',
      },
    }));
    const server = new CapturingServer();

    registerVerificationTools(asServer(server), {
      plan: vi.fn(),
      run: vi.fn(),
      status: vi.fn(),
      evidence,
    });

    const response = await handler(server, 'verification_evidence')({
      taskId: selected,
    });
    const text = response.content[0]?.text ?? '';

    expect(evidence).toHaveBeenCalledTimes(1);
    expect(evidence).toHaveBeenCalledWith(selected);
    expect(text).toContain(selected);
    expect(text).toContain('cmd:77');
    expect(text).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz');
    expect(text).not.toContain('Bearer sk-proj');
  });
});
