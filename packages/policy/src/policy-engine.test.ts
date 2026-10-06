import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ApprovalService, type ApprovalRecord, type ApprovalStore } from './approval-service.js';
import { normalizeExecutableCommand, normalizeShellCommand } from './command-parser.js';
import { PolicyEngine, type PolicyContext } from './policy-engine.js';

const tempDirs: string[] = [];
const risk = { ALLOW: 0, NEEDS_APPROVAL: 1, DENY: 2 } as const;
const BACKTICK = String.fromCharCode(96);

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

  it('allows only the issued task worktree lifecycle argument shapes', () => {
    expect(decide('git worktree add -b feat/task-1 /tmp/wt-1 origin/main').kind).toBe('ALLOW');
    expect(decide('git worktree remove --force /tmp/wt-1').kind).toBe('ALLOW');
    expect(decide('git worktree prune').kind).toBe('ALLOW');
  });

  it('keeps other worktree shapes and an absent task identity approval-required', () => {
    expect(decide('git worktree').kind).toBe('NEEDS_APPROVAL');
    expect(decide('git worktree list').kind).toBe('NEEDS_APPROVAL');
    expect(decide('git worktree lock /tmp/wt-1').kind).toBe('NEEDS_APPROVAL');
    expect(decide('git worktree move /tmp/wt-1 /tmp/wt-2').kind).toBe('NEEDS_APPROVAL');
    expect(decide('git worktree repair').kind).toBe('NEEDS_APPROVAL');
    expect(decide('git worktree unlock /tmp/wt-1').kind).toBe('NEEDS_APPROVAL');
    expect(decide('git worktree add feat/task-1 /tmp/wt-1 origin/main').kind).toBe('NEEDS_APPROVAL');
    expect(decide('git worktree remove /tmp/wt-1').kind).toBe('NEEDS_APPROVAL');
    expect(decide('git worktree add -b feat/task-1 /tmp/wt-1 origin/main --checkout').kind).toBe(
      'NEEDS_APPROVAL',
    );
    expect(
      decide('git worktree add -b feat/task-1 /tmp/wt-1 origin/main', {
        taskId: '   ',
        protectedBranches: ['main'],
      }).kind,
    ).toBe('NEEDS_APPROVAL');
  });

  it('preserves approval decisions for unresolved push and destructive or unknown git commands', () => {
    expect(decide('git push origin').kind).toBe('NEEDS_APPROVAL');
    expect(decide('git push origin feature').kind).toBe('ALLOW');
    expect(decide('git reset --hard HEAD~1').kind).toBe('NEEDS_APPROVAL');
    expect(decide('git clean -fdx').kind).toBe('NEEDS_APPROVAL');
    expect(decide('git worktree frobnicate').kind).toBe('NEEDS_APPROVAL');
  });

  it('allows only a single Windows path conversion with wslpath -w', () => {
    expect(decide('wslpath -w /home/agent/.gram-agent/worktrees/7/task-1').kind).toBe('ALLOW');
  });

  it('requires approval for unsupported wslpath forms', () => {
    expect(decide('wslpath').kind).toBe('NEEDS_APPROVAL');
    expect(decide('wslpath -u /mnt/c/x').kind).toBe('NEEDS_APPROVAL');
    expect(decide('wslpath -w').kind).toBe('NEEDS_APPROVAL');
    expect(decide('wslpath -w relative/path').kind).toBe('NEEDS_APPROVAL');
    expect(decide('wslpath -w /tmp/x --extra').kind).toBe('NEEDS_APPROVAL');
  });
});


describe('shell-text syntax fail-closed boundary', () => {
  it.each([
    ['stdout redirect', 'echo ok > /tmp/probe'],
    ['stdout append', 'echo ok >> /tmp/probe'],
    ['stderr redirect', 'echo ok 2>/tmp/probe'],
    ['stderr append', 'echo ok 2>>/tmp/probe'],
    ['combined redirect', 'echo ok &>/tmp/probe'],
    ['heredoc', 'cat <<EOF\nhello\nEOF'],
    [
      'worktree suffix redirect',
      'git worktree add -b feat/x /home/agent/.gram-agent/worktrees/7/task-1 HEAD>/tmp/probe',
    ],
    ['command substitution', 'echo $(touch /tmp/probe)'],
    ['double-quoted command substitution', 'echo "$(touch /tmp/probe)"'],
    ['backtick command substitution', `echo ${BACKTICK}touch /tmp/probe${BACKTICK}`],
    [
      'double-quoted backtick command substitution',
      `echo "a ${BACKTICK}touch /tmp/probe${BACKTICK} c"`,
    ],
  ] as const)('rejects %s before classification', (_label, command) => {
    expect(() => normalizeShellCommand(command, process.cwd())).toThrow(
      /unsupported shell syntax/i,
    );
  });

  it.each([
    ['double-quoted redirect literal', 'echo "a>b"', ['a>b']],
    ['single-quoted redirect literal', "echo 'a>b'", ['a>b']],
    ['escaped redirect literal', 'echo a\\>b', ['a>b']],
    [
      'single-quoted command-substitution literal',
      "echo '$(touch /tmp/probe)'",
      ['$(touch /tmp/probe)'],
    ],
    [
      'single-quoted backtick literal',
      `echo '${BACKTICK}touch /tmp/probe${BACKTICK}'`,
      [`${BACKTICK}touch /tmp/probe${BACKTICK}`],
    ],
    [
      'escaped backtick literal',
      `echo a\\${BACKTICK}b`,
      [`a${BACKTICK}b`],
    ],
  ] as const)('keeps %s literal', (_label, command, expectedArgs) => {
    const [operation] = normalizeShellCommand(command, process.cwd());
    expect(operation?.executable).toBe('echo');
    expect(operation?.args).toEqual(expectedArgs);
  });

  it('does not apply shell syntax rejection to executable-form requests', () => {
    const operation = normalizeExecutableCommand(
      'echo',
      ['a>b', '$(literal)'],
      process.cwd(),
    );
    expect(operation.args).toEqual(['a>b', '$(literal)']);
    expect(new PolicyEngine().evaluate(operation, { taskId: 'task-1' }).kind).toBe(
      'ALLOW',
    );
  });

  it.each([
    ['rm', 'rm ./a', ['./a']],
    ['cp', 'cp ./a ./b', ['./a', './b']],
    ['mv', 'mv ./a ./b', ['./a', './b']],
  ] as const)('preserves existing %s filesystem target extraction', (_label, command, targets) => {
    const [operation] = normalizeShellCommand(command, process.cwd());
    expect(operation?.requestedTargets).toEqual(targets);
  });
});


describe('shell filesystem target expansion fail-closed boundary', () => {
  it('rejects tilde expansion even when a literal decoy path canonicalizes', () => {
    const root = mkdtempSync(join(tmpdir(), 'gram-policy-expand-'));
    tempDirs.push(root);
    mkdirSync(join(root, '~'), { recursive: true });
    writeFileSync(join(root, '~', 'tmpfile'), 'decoy');

    const [before] = normalizeShellCommand('rm ~/tmpfile', root);
    expect(before?.pathResolutionFailed).toBe(false);
    expect(before?.canonicalTargets).toEqual([realpathSync(join(root, '~', 'tmpfile'))]);
    expect(new PolicyEngine().evaluate(before!, { taskId: 'task-1' }).kind).toBe('ALLOW');

    expect(() => normalizeShellCommand('rm ~/tmpfile', root)).toThrow(
      /unsupported shell syntax/i,
    );
  });

  it.each([
    ['rm', 'rm *.log'],
    ['cp', 'cp *.log copy.log'],
    ['mv', 'mv *.log moved.log'],
  ] as const)('rejects unquoted glob expansion for %s filesystem targets', (_label, command) => {
    const root = mkdtempSync(join(tmpdir(), 'gram-policy-expand-'));
    tempDirs.push(root);
    writeFileSync(join(root, '*.log'), 'literal-decoy');
    writeFileSync(join(root, 'victim.log'), 'victim');

    expect(() => normalizeShellCommand(command, root)).toThrow(
      /unsupported shell syntax/i,
    );
  });

  it.each([
    ["rm '~/tmpfile'", ['~/tmpfile']],
    ['rm "*.log"', ['*.log']],
    ['rm \\*.log', ['*.log']],
  ] as const)('keeps quoted or escaped filesystem target literal: %s', (command, targets) => {
    const root = mkdtempSync(join(tmpdir(), 'gram-policy-expand-'));
    tempDirs.push(root);
    if (targets[0] === '~/tmpfile') {
      mkdirSync(join(root, '~'), { recursive: true });
      writeFileSync(join(root, '~', 'tmpfile'), 'literal');
    } else {
      writeFileSync(join(root, '*.log'), 'literal');
    }

    const [operation] = normalizeShellCommand(command, root);
    expect(operation?.requestedTargets).toEqual(targets);
    expect(operation?.pathResolutionFailed).toBe(false);
  });

  it('does not apply shell pathname expansion checks to executable-form requests', () => {
    const root = mkdtempSync(join(tmpdir(), 'gram-policy-expand-'));
    tempDirs.push(root);
    writeFileSync(join(root, '*.log'), 'literal');

    const operation = normalizeExecutableCommand('rm', ['*.log'], root);
    expect(operation.requestedTargets).toEqual(['*.log']);
    expect(operation.pathResolutionFailed).toBe(false);
    expect(new PolicyEngine().evaluate(operation, { taskId: 'task-1' }).kind).toBe('ALLOW');
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
