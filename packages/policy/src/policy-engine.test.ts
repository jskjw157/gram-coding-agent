import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ApprovalService, type ApprovalRecord, type ApprovalStore } from './approval-service.js';
import { normalizeShellCommand } from './command-parser.js';
import { PolicyEngine, type PolicyContext } from './policy-engine.js';

const tempDirs: string[] = [];
const risk = { ALLOW: 0, NEEDS_APPROVAL: 1, DENY: 2 } as const;

function decide(command: string, context: PolicyContext = { taskId: 'task-1', protectedBranches: ['main'] }) {
  const engine = new PolicyEngine();
  const decisions = normalizeShellCommand(command, process.cwd()).map((operation) =>
    engine.evaluate(operation, context),
  );
  if (decisions.length === 0) throw new Error('expected at least one operation');
  return decisions.reduce((highest, current) =>
    risk[current.kind] > risk[highest.kind] ? current : highest,
  );
}

afterEach(() => {
  let dir: string | undefined;
  while ((dir = tempDirs.pop()) !== undefined) rmSync(dir, { recursive: true, force: true });
});

describe('Policy Engine v1 rule matrix', () => {
  it.each([
    ['git status', 'ALLOW'],
    ['git ls-remote origin refs/heads/feature', 'ALLOW'],
    ['pnpm test', 'ALLOW'],
    ['sudo apt install jq', 'ALLOW'],
    ['powershell.exe -Command Get-ChildItem', 'NEEDS_APPROVAL'],
    ['pwsh.exe -Command Get-ChildItem', 'NEEDS_APPROVAL'],
    ['cmd.exe /c dir', 'NEEDS_APPROVAL'],
    ['git reset --hard HEAD~1', 'NEEDS_APPROVAL'],
    ['git clean -fdx', 'NEEDS_APPROVAL'],
    ['rm -rf /', 'DENY'],
    ['git push --force origin main', 'DENY'],
    ['git push --force-with-lease origin main', 'DENY'],
    ['git push --force origin HEAD:main', 'DENY'],
    ['git push --force origin HEAD:refs/heads/main', 'DENY'],
    ['git push origin +HEAD:main', 'DENY'],
    ['git push --delete origin main', 'DENY'],
    ['git push origin :refs/heads/main', 'DENY'],
    ['git push --force origin feature main', 'DENY'],
    ['git push origin feature main', 'NEEDS_APPROVAL'],
    ['git push origin feature', 'ALLOW'],
    ['git push origin', 'NEEDS_APPROVAL'],
    ['git push --all origin', 'NEEDS_APPROVAL'],
    ['git push --force --all origin', 'DENY'],
    ['git push --mirror origin', 'DENY'],
    ['git push --force origin refs/heads/*:refs/heads/*', 'DENY'],
    ['git push origin refs/heads/*:refs/heads/*', 'NEEDS_APPROVAL'],
  ] as const)('%s -> %s', (command, expected) => {
    expect(decide(command).kind).toBe(expected);
  });

  it('requires the direct-main grant for protected destinations expressed as refspecs', () => {
    expect(decide('git push origin HEAD:main').kind).toBe('NEEDS_APPROVAL');
    expect(decide('git push origin HEAD:refs/heads/main').kind).toBe('NEEDS_APPROVAL');
    expect(decide('git push origin HEAD:refs/heads/main', {
      taskId: 'task-1',
      protectedBranches: ['main'],
      directMainGranted: false,
      targetBranch: 'main',
      publishMode: 'PULL_REQUEST',
    }).kind).toBe('NEEDS_APPROVAL');
    expect(decide('git push origin HEAD:main', {
      taskId: 'task-1',
      protectedBranches: ['main'],
      directMainGranted: true,
      targetBranch: 'main',
      publishMode: 'DIRECT_MAIN',
    }).kind).toBe('ALLOW');
    expect(decide('git push --force-with-lease origin HEAD:main', {
      taskId: 'task-1',
      protectedBranches: ['main'],
      directMainGranted: true,
      targetBranch: 'main',
      publishMode: 'DIRECT_MAIN',
    }).kind).toBe('DENY');
  });

  it('uses the highest risk decision across composed commands', () => {
    expect(decide('git status && rm -rf /').kind).toBe('DENY');
    expect(decide('echo ok; powershell.exe -Command whoami').kind).toBe('NEEDS_APPROVAL');
  });

  it('preserves shell composition boundaries as separate operations', () => {
    const operations = normalizeShellCommand('git status && pnpm test | cat', process.cwd());
    expect(operations.map((operation) => operation.executable)).toEqual(['git', 'pnpm', 'cat']);
    expect(operations.map((operation) => operation.precededBy)).toEqual([null, '&&', '|']);
  });
});

describe('path-sensitive normalization', () => {
  it('retains requested and canonical filesystem targets', () => {
    const root = mkdtempSync(join(tmpdir(), 'gram-policy-'));
    tempDirs.push(root);
    const target = join(root, 'target');
    mkdirSync(target);

    const [operation] = normalizeShellCommand('rm -rf ./target', root);
    expect(operation?.requestedTargets).toEqual(['./target']);
    expect(operation?.canonicalTargets).toEqual([realpathSync(target)]);
    expect(operation?.pathResolutionFailed).toBe(false);
  });

  it('never auto-allows a destructive operation when canonicalization fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'gram-policy-'));
    tempDirs.push(root);
    const [operation] = normalizeShellCommand('rm -rf ./missing', root);
    if (!operation) throw new Error('operation missing');
    expect(operation.pathResolutionFailed).toBe(true);
    expect(new PolicyEngine().evaluate(operation, { taskId: 'task-1' }).kind).toBe('NEEDS_APPROVAL');
  });
});

describe('operation hashes and approvals', () => {
  it('binds operation hashes to normalized operation plus task identity', () => {
    const [operation] = normalizeShellCommand('git status', process.cwd());
    if (!operation) throw new Error('operation missing');
    const engine = new PolicyEngine();
    const a = engine.evaluate(operation, { taskId: 'task-a' });
    const aAgain = engine.evaluate(operation, { taskId: 'task-a' });
    const b = engine.evaluate(operation, { taskId: 'task-b' });
    expect(a.operationHash).toMatch(/^[0-9a-f]{64}$/);
    expect(aAgain.operationHash).toBe(a.operationHash);
    expect(b.operationHash).not.toBe(a.operationHash);
  });

  it('rejects approval hash mismatches and approval reuse', () => {
    class MemoryApprovalStore implements ApprovalStore {
      readonly records = new Map<string, ApprovalRecord>();
      get(id: string): ApprovalRecord | null {
        return this.records.get(id) ?? null;
      }
      markApproved(id: string): void {
        const current = this.records.get(id);
        if (!current) throw new Error('missing approval');
        this.records.set(id, { ...current, status: 'APPROVED' });
      }
    }

    const store = new MemoryApprovalStore();
    store.records.set('approval-1', {
      id: 'approval-1',
      taskId: 'task-a',
      operationHash: 'a'.repeat(64),
      status: 'PENDING',
    });
    const approvals = new ApprovalService(store);

    expect(() => approvals.approve('approval-1', 'b'.repeat(64))).toThrow(/hash/i);
    approvals.approve('approval-1', 'a'.repeat(64));
    expect(store.get('approval-1')?.status).toBe('APPROVED');
    expect(() => approvals.approve('approval-1', 'a'.repeat(64))).toThrow(/already/i);
  });
});
