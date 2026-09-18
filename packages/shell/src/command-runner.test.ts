import { describe, expect, it, vi } from 'vitest';
import { PolicyEngine } from '@gram/policy';
import {
  ApprovalRequiredError,
  CommandRunner,
  PolicyDeniedError,
  type ApprovalConsumptionPort,
  type ProcessSpawner,
} from './command-runner.js';

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
    });

    await expect(runner.run(request('git status'))).resolves.toMatchObject({ exitCode: 0 });
    expect(evaluate).toHaveBeenCalled();
    expect(events).toEqual(['policy', 'spawn']);
  });
});
