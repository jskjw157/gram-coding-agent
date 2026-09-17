import { afterEach, describe, expect, it } from 'vitest';
import { createMcpHttpServer, type RunningMcpServer } from '../../packages/mcp/src/server.js';
import { normalizeShellCommand } from '../../packages/policy/src/command-parser.js';
import { PolicyEngine, type PolicyContext } from '../../packages/policy/src/policy-engine.js';

const running: RunningMcpServer[] = [];
const engine = new PolicyEngine();
const context: PolicyContext = {
  taskId: 'm1-security-acceptance',
  protectedBranches: ['main', 'master'],
};
const riskRank = { ALLOW: 0, NEEDS_APPROVAL: 1, DENY: 2 } as const;

afterEach(async () => {
  while (running.length > 0) await running.pop()?.close();
});

function decide(command: string): 'ALLOW' | 'NEEDS_APPROVAL' | 'DENY' {
  const decisions = normalizeShellCommand(command, process.cwd()).map((operation) =>
    engine.evaluate(operation, context),
  );
  return decisions.reduce<'ALLOW' | 'NEEDS_APPROVAL' | 'DENY'>((highest, decision) =>
    riskRank[decision.kind] > riskRank[highest] ? decision.kind : highest,
  'ALLOW');
}

describe('M1 security acceptance matrix', () => {
  it.each([
    'powershell.exe -Command Get-ChildItem',
    'pwsh.exe -Command Get-ChildItem',
    'cmd.exe /c dir',
  ])('keeps raw Windows execution approval-gated: %s', (command) => {
    expect(decide(command)).toBe('NEEDS_APPROVAL');
  });

  it('denies recursive root deletion', () => {
    expect(decide('rm -rf /')).toBe('DENY');
  });

  it.each([
    'git push --force origin main',
    'git push --force-with-lease origin main',
  ])('denies protected-branch force push: %s', (command) => {
    expect(decide(command)).toBe('DENY');
  });

  it('rejects missing and wrong MCP secrets and accepts loopback binding', async () => {
    const server = await createMcpHttpServer({
      host: '127.0.0.1',
      port: 0,
      internalSecret: 'acceptance-secret',
    });
    running.push(server);

    expect(server.host).toBe('127.0.0.1');

    const missing = await fetch(`${server.url}/mcp`);
    expect(missing.status).toBe(401);

    const wrong = await fetch(`${server.url}/mcp`, {
      headers: { 'x-gram-agent-auth': 'wrong-secret' },
    });
    expect(wrong.status).toBe(401);
  });
});
