import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CommandRunRepository,
  openDatabase,
  runMigrations,
  TaskRepository,
} from '@gram/persistence';
import { PolicyEngine } from '@gram/policy';
import { SecretRedactor } from '@gram/secrets';
import { CommandRunner, type ProcessSpawner } from './command-runner.js';
import { OutputCapture } from './output-capture.js';

const roots: string[] = [];
const databases: Array<{ close(): void }> = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gram-shell-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (databases.length) databases.pop()?.close();
  let root: string | undefined;
  while ((root = roots.pop()) !== undefined) rmSync(root, { recursive: true, force: true });
});

describe('CommandRunner evidence and environment isolation', () => {
  it('commits RUNNING before spawn, passes only safe env, and stores redacted logs before finishing', async () => {
    const root = tempRoot();
    const db = openDatabase(join(root, 'state.db'));
    databases.push(db);
    runMigrations(db);

    const tasks = new TaskRepository(db);
    const task = tasks.create({
      goal: 'verify command evidence',
      taskType: 'CODING',
      publishMode: 'PULL_REQUEST',
    });
    const commandRuns = new CommandRunRepository(db);
    const secret = 'sk-test-secret-1234567890';
    const outputCapture = new OutputCapture({
      homeDir: root,
      redactor: new SecretRedactor([secret]),
    });

    const spawn: ProcessSpawner['spawn'] = vi.fn(async (input) => {
      const row = db
        .prepare('SELECT id, status FROM command_runs WHERE task_id = ? ORDER BY id DESC LIMIT 1')
        .get(task.id) as { id: number; status: string } | undefined;
      expect(row?.status).toBe('RUNNING');
      expect(input.env).toEqual({
        HOME: '/home/test',
        LANG: 'C.UTF-8',
        PATH: '/usr/bin',
      });
      return {
        exitCode: 0,
        stdout: `hello ${secret}\n`,
        stderr: 'Authorization: Bearer leak-me\n',
      };
    });

    const runner = new CommandRunner({
      policy: new PolicyEngine(),
      approvals: { consume: async () => false },
      spawner: { spawn },
      commandRuns,
      outputCapture,
      environment: {
        PATH: '/usr/bin',
        HOME: '/home/test',
        LANG: 'C.UTF-8',
        GITHUB_TOKEN: 'github-secret',
        GH_TOKEN: 'gh-secret',
        OPENAI_API_KEY: 'sk-openai-secret',
        TUNNEL_RUNTIME_KEY: 'tunnel-secret',
        GRAM_AGENT_MCP_INTERNAL_SECRET: 'mcp-secret',
        RANDOM_SECRET: 'do-not-inherit',
      },
    });

    const result = await runner.run({
      taskId: task.id,
      cwd: root,
      category: 'VERIFICATION',
      shellText: 'git status',
    });

    const row = db
      .prepare('SELECT * FROM command_runs WHERE task_id = ?')
      .get(task.id) as Record<string, unknown>;
    expect(row.status).toBe('SUCCEEDED');
    expect(row.exit_code).toBe(0);

    const stdoutPath = join(
      root,
      '.gram-agent',
      'logs',
      'tasks',
      task.id,
      `cmd-${String(row.id)}.stdout`,
    );
    const stderrPath = join(
      root,
      '.gram-agent',
      'logs',
      'tasks',
      task.id,
      `cmd-${String(row.id)}.stderr`,
    );
    expect(row.stdout_path).toBe(stdoutPath);
    expect(row.stderr_path).toBe(stderrPath);

    const storedStdout = readFileSync(stdoutPath, 'utf8');
    const storedStderr = readFileSync(stderrPath, 'utf8');
    expect(storedStdout).not.toContain(secret);
    expect(storedStdout).toContain('***REDACTED***');
    expect(storedStderr).not.toContain('leak-me');
    expect(storedStderr).toContain('***REDACTED***');
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain('leak-me');
  });

  it('persists a non-zero process result as FAILED with its exit code', async () => {
    const root = tempRoot();
    const db = openDatabase(join(root, 'state.db'));
    databases.push(db);
    runMigrations(db);

    const task = new TaskRepository(db).create({
      goal: 'failing verification',
      taskType: 'CODING',
      publishMode: 'PULL_REQUEST',
    });
    const commandRuns = new CommandRunRepository(db);
    const runner = new CommandRunner({
      policy: new PolicyEngine(),
      approvals: { consume: async () => false },
      spawner: {
        spawn: async () => ({ exitCode: 7, stdout: '', stderr: 'failed\n' }),
      },
      commandRuns,
      outputCapture: new OutputCapture({
        homeDir: root,
        redactor: new SecretRedactor(),
      }),
      environment: { PATH: '/usr/bin' },
    });

    const result = await runner.run({
      taskId: task.id,
      cwd: root,
      category: 'VERIFICATION',
      shellText: 'git status',
    });

    expect(result.exitCode).toBe(7);
    const row = db
      .prepare('SELECT status, exit_code FROM command_runs WHERE task_id = ?')
      .get(task.id);
    expect(row).toEqual({ status: 'FAILED', exit_code: 7 });
  });
});
