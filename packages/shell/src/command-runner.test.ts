import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PolicyEngine } from '@gram/policy';
import {
  ApprovalRequiredError,
  CommandRunner,
  PolicyDeniedError,
  type ApprovalConsumptionPort,
  type ProcessSpawner,
} from './command-runner.js';

// Temporary agent homes created by the worktree preflight tests. Tracked at
// module scope and removed in afterEach so a test run leaves nothing behind.
const tempHomes: string[] = [];

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'gram-runner-home-'));
  tempHomes.push(home);
  return home;
}

afterEach(() => {
  let home: string | undefined;
  while ((home = tempHomes.pop()) !== undefined) {
    rmSync(home, { recursive: true, force: true });
  }
});

function evidencePorts() {
  return {
    commandRuns: {
      start: vi.fn(() => 1),
      finish: vi.fn(),
    },
    outputCapture: {
      redactText: vi.fn((text: string) => text),
      capture: vi.fn(async ({ stdout, stderr }: { stdout: string; stderr: string }) => ({
        stdout,
        stderr,
        stdoutPath: '/tmp/stdout',
        stderrPath: '/tmp/stderr',
      })),
    },
    environment: { PATH: '/usr/bin', HOME: '/tmp', LANG: 'C.UTF-8' },
  };
}

function request(shellText: string) {
  return {
    taskId: '018d8a73-6b4e-7000-8000-000000000001',
    cwd: process.cwd(),
    category: 'DEVELOPMENT',
    shellText,
  } as const;
}

describe('CommandRunner policy gate', () => {
  it('evaluates policy before spawning and never spawns a DENY command', async () => {
    const spawn: ProcessSpawner['spawn'] = vi.fn(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));
    const approvals: ApprovalConsumptionPort = {
      consume: vi.fn(async () => false),
    };
    const runner = new CommandRunner({
      policy: new PolicyEngine(),
      approvals,
      spawner: { spawn },
      ...evidencePorts(),
    });

    await expect(runner.run(request('rm -rf /'))).rejects.toThrow(PolicyDeniedError);
    expect(spawn).not.toHaveBeenCalled();
    expect(approvals.consume).not.toHaveBeenCalled();
  });

  it('does not spawn NEEDS_APPROVAL until a matching approval is consumed', async () => {
    const spawn: ProcessSpawner['spawn'] = vi.fn(async () => ({
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
    }));
    const consume = vi
      .fn<ApprovalConsumptionPort['consume']>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const runner = new CommandRunner({
      policy: new PolicyEngine(),
      approvals: { consume },
      spawner: { spawn },
      ...evidencePorts(),
    });
    const command = request('powershell.exe -Command Get-ChildItem');

    await expect(runner.run(command)).rejects.toThrow(ApprovalRequiredError);
    expect(spawn).not.toHaveBeenCalled();
    expect(consume).toHaveBeenCalledTimes(1);
    const [taskId, operationHash] = consume.mock.calls[0] ?? [];
    expect(taskId).toBe(command.taskId);
    expect(operationHash).toMatch(/^[0-9a-f]{64}$/);

    await expect(runner.run(command)).resolves.toMatchObject({
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
    });
    expect(consume).toHaveBeenCalledTimes(2);
    expect(consume.mock.calls[1]?.[1]).toBe(operationHash);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('spawns an ALLOW command only after policy evaluation', async () => {
    const events: string[] = [];
    const policy = new PolicyEngine();
    const evaluate = vi.spyOn(policy, 'evaluate').mockImplementation((operation, context) => {
      events.push('policy');
      return new PolicyEngine().evaluate(operation, context);
    });
    const spawn: ProcessSpawner['spawn'] = vi.fn(async () => {
      events.push('spawn');
      return { exitCode: 0, stdout: 'clean', stderr: '' };
    });
    const runner = new CommandRunner({
      policy,
      approvals: { consume: async () => false },
      spawner: { spawn },
      ...evidencePorts(),
    });

    await expect(runner.run(request('git status'))).resolves.toMatchObject({ exitCode: 0 });
    expect(evaluate).toHaveBeenCalled();
    expect(events).toEqual(['policy', 'spawn']);
  });


  it('rejects unsupported shell syntax before approval, evidence, or spawn', async () => {
    const homeDir = tempHome();
    const taskId = '0191a2b3-c4d5-7000-8000-000000000024';
    const spawn: ProcessSpawner['spawn'] = vi.fn(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));
    const consume = vi.fn<ApprovalConsumptionPort['consume']>(async () => true);
    const ports = evidencePorts();
    const runner = new CommandRunner({
      policy: new PolicyEngine(),
      approvals: { consume },
      spawner: { spawn },
      homeDir,
      ...ports,
    });

    await expect(
      runner.run({
        taskId,
        cwd: process.cwd(),
        category: 'GIT',
        shellText:
          'git worktree add -b feat/x /home/agent/.gram-agent/worktrees/7/' +
          taskId +
          ' HEAD>/tmp/probe',
      }),
    ).rejects.toThrow(/unsupported shell syntax/i);

    expect(consume).not.toHaveBeenCalled();
    expect(ports.commandRuns.start).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('keeps executable-form redirect-looking arguments literal', async () => {
    const spawn: ProcessSpawner['spawn'] = vi.fn(async () => ({
      exitCode: 0,
      stdout: 'literal',
      stderr: '',
    }));
    const ports = evidencePorts();
    const runner = new CommandRunner({
      policy: new PolicyEngine(),
      approvals: { consume: async () => false },
      spawner: { spawn },
      ...ports,
    });

    await expect(
      runner.run({
        taskId: '0191a2b3-c4d5-7000-8000-000000000025',
        cwd: process.cwd(),
        category: 'DEVELOPMENT',
        executable: 'echo',
        args: ['a>b', '$(literal)'],
      }),
    ).resolves.toMatchObject({ exitCode: 0, stdout: 'literal' });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: 'echo',
        args: ['a>b', '$(literal)'],
      }),
    );
  });

  it('denies an ALLOW-shaped worktree add outside agent home before approval or spawn', async () => {
    const homeDir = tempHome();
    const taskId = '0191a2b3-c4d5-7000-8000-000000000021';
    const spawn: ProcessSpawner['spawn'] = vi.fn(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));
    const consume = vi.fn<ApprovalConsumptionPort['consume']>(async () => true);
    const ports = evidencePorts();
    const runner = new CommandRunner({
      policy: new PolicyEngine(),
      approvals: { consume },
      spawner: { spawn },
      homeDir,
      ...ports,
    });

    const error = await runner
      .run({
        taskId,
        cwd: process.cwd(),
        category: 'GIT',
        executable: 'git',
        args: ['worktree', 'add', '-b', 'feat/task-000021-x', '/tmp/gram-outside-evil/wt', 'origin/main'],
      })
      .catch((candidate: unknown) => candidate);
    expect(error).toBeInstanceOf(PolicyDeniedError);
    expect((error as PolicyDeniedError).decision.ruleId).toBe('POL-GIT-WORKTREE-PATH');
    expect((error as PolicyDeniedError).decision.reason).toBe(
      'worktree target must be within the agent task-worktree layout',
    );
    expect(consume).toHaveBeenCalledTimes(0);
    expect(ports.commandRuns.start).toHaveBeenCalledTimes(0);
    expect(spawn).toHaveBeenCalledTimes(0);
  });

  it('denies a forced worktree removal outside agent home before approval or spawn', async () => {
    const homeDir = tempHome();
    const taskId = '0191a2b3-c4d5-7000-8000-000000000022';
    const spawn: ProcessSpawner['spawn'] = vi.fn(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));
    const consume = vi.fn<ApprovalConsumptionPort['consume']>(async () => true);
    const ports = evidencePorts();
    const runner = new CommandRunner({
      policy: new PolicyEngine(),
      approvals: { consume },
      spawner: { spawn },
      homeDir,
      ...ports,
    });

    const error = await runner
      .run({
        taskId,
        cwd: process.cwd(),
        category: 'GIT',
        executable: 'git',
        args: ['worktree', 'remove', '--force', '/tmp/gram-outside-evil/wt'],
      })
      .catch((candidate: unknown) => candidate);
    expect(error).toBeInstanceOf(PolicyDeniedError);
    expect((error as PolicyDeniedError).decision.ruleId).toBe('POL-GIT-WORKTREE-PATH');
    expect(consume).toHaveBeenCalledTimes(0);
    expect(ports.commandRuns.start).toHaveBeenCalledTimes(0);
    expect(spawn).toHaveBeenCalledTimes(0);
  });

  it('fails closed for a worktree command when no homeDir is configured', async () => {
    const taskId = '0191a2b3-c4d5-7000-8000-000000000023';
    const spawn: ProcessSpawner['spawn'] = vi.fn(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));
    const consume = vi.fn<ApprovalConsumptionPort['consume']>(async () => true);
    const ports = evidencePorts();
    const runner = new CommandRunner({
      policy: new PolicyEngine(),
      approvals: { consume },
      spawner: { spawn },
      ...ports,
    });

    const error = await runner
      .run({
        taskId,
        cwd: process.cwd(),
        category: 'GIT',
        executable: 'git',
        args: [
          'worktree',
          'add',
          '-b',
          'feat/task-000023-x',
          `/home/agent/.gram-agent/worktrees/7/${taskId}`,
          'origin/main',
        ],
      })
      .catch((candidate: unknown) => candidate);
    expect(error).toBeInstanceOf(PolicyDeniedError);
    expect((error as PolicyDeniedError).decision.ruleId).toBe('POL-GIT-WORKTREE-PATH');
    expect(consume).toHaveBeenCalledTimes(0);
    expect(ports.commandRuns.start).toHaveBeenCalledTimes(0);
    expect(spawn).toHaveBeenCalledTimes(0);
  });
});
