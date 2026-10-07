import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  openDatabase,
  runMigrations,
  TaskRepository,
  RepositoryRepository,
  WorkspaceRepository,
  LockRepository,
} from '@gram/persistence';
import { TaskRunner } from '@gram/task-engine';
import { startAgent, type RunningAgent } from './main.js';
import * as runnerComposition from './task-runner-composition.js';
import * as githubServices from './github-services.js';
import { TaskScheduler } from './task-scheduler.js';

const tempDirs: string[] = [];
const running: RunningAgent[] = [];

afterEach(async () => {
  let app: RunningAgent | undefined;
  while ((app = running.pop()) !== undefined) await app.close();
  let dir: string | undefined;
  while ((dir = tempDirs.pop()) !== undefined) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gram-agent-'));
  tempDirs.push(root);
  const stateDirectory = join(root, 'state');
  const secretDirectory = join(root, 'secrets');
  mkdirSync(stateDirectory, { recursive: true });
  mkdirSync(secretDirectory, { recursive: true, mode: 0o700 });
  const secretPath = join(secretDirectory, 'mcp-internal-secret');
  writeFileSync(secretPath, 'integration-secret\n', { mode: 0o600 });
  chmodSync(secretPath, 0o600);
  return { stateDirectory, secretDirectory };
}

describe('agent composition root', () => {
  it('starts loopback MCP and reports healthy database/MCP state', async () => {
    const paths = fixture();
    const app = await startAgent({
      ...paths,
      host: '127.0.0.1',
      port: 0,
      installSignalHandlers: false,
    });
    running.push(app);

    expect(app.host).toBe('127.0.0.1');
    expect(app.port).toBeGreaterThan(0);

    const response = await fetch(`${app.url}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'healthy', database: 'ok', mcp: 'ready' });
    expect(app.health()).toEqual({ status: 'healthy', database: 'ok', mcp: 'ready' });
  });

  it('closes the listener and database cleanly', async () => {
    const app = await startAgent({ ...fixture(), port: 0, installSignalHandlers: false });
    const url = app.url;
    await app.close();
    await expect(fetch(`${url}/healthz`)).rejects.toThrow();
  });

  it('starts the scheduler after MCP startup and preserves healthy agent startup', async () => {
    const paths = fixture();
    const seededId = seedQueuedTask(paths.stateDirectory);
    const startSpy = vi.spyOn(TaskScheduler.prototype, 'start');
    const runSpy = vi.spyOn(TaskRunner.prototype, 'run');
    try {
      const pending = startAgent({
        ...paths,
        host: '127.0.0.1',
        port: 0,
        installSignalHandlers: false,
      });
      // The scheduler must not dispatch before the MCP server is ready:
      // startAgent has not resolved, so neither start() nor any run() may
      // have happened yet.
      expect(startSpy).not.toHaveBeenCalled();
      expect(runSpy).not.toHaveBeenCalled();

      const app = await pending;
      running.push(app);

      expect(startSpy).toHaveBeenCalledTimes(1);

      // Pre-existing healthy-startup assertions still hold.
      expect(app.host).toBe('127.0.0.1');
      expect(app.port).toBeGreaterThan(0);
      const response = await fetch(`${app.url}/healthz`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'healthy', database: 'ok', mcp: 'ready' });
      expect(app.health()).toEqual({ status: 'healthy', database: 'ok', mcp: 'ready' });

      // The scheduler started after MCP was ready: the QUEUED task seeded
      // before startup was dispatched exactly once.
      expect(runSpy).toHaveBeenCalledTimes(1);
      expect(runSpy).toHaveBeenCalledWith(seededId);
      await drainMicrotasks();
      expect(readTaskStatus(paths.stateDirectory, seededId)).not.toBe('QUEUED');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('close stops scheduling synchronously closes MCP drains in-flight runs and then closes SQLite', async () => {
    const paths = fixture();
    const seededId = seedQueuedTask(paths.stateDirectory);
    const gate = deferred();
    const runSpy = vi.spyOn(TaskRunner.prototype, 'run').mockImplementation(async () => {
      await gate.promise;
    });
    try {
      const app = await startAgent({
        ...paths,
        host: '127.0.0.1',
        port: 0,
        installSignalHandlers: false,
      });
      running.push(app);
      const url = app.url;

      // The seeded QUEUED task was dispatched into the barrier-held run.
      expect(runSpy).toHaveBeenCalledTimes(1);
      expect(runSpy).toHaveBeenCalledWith(seededId);

      let settled = false;
      const closing = app.close();
      void closing.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      // Dispatch is refused synchronously after close(): a task queued now
      // is never dispatched.
      const secondId = createQueuedTask(paths.stateDirectory);
      await drainMicrotasks();
      await pumpEventLoop();
      expect(runSpy).toHaveBeenCalledTimes(1);
      expect(readTaskStatus(paths.stateDirectory, secondId)).toBe('QUEUED');

      // MCP is closed while the in-flight run is still held open ...
      // (bounded event-driven wait: each iteration awaits real socket IO,
      // never a sleep; the drain gate stays held the whole time).
      let mcpClosed = false;
      for (let attempt = 0; attempt < 10 && mcpClosed === false; attempt += 1) {
        try {
          const probe = await fetch(`${url}/healthz`);
          await probe.text();
        } catch {
          mcpClosed = true;
        }
        if (mcpClosed === false) await pumpEventLoop();
      }
      expect(mcpClosed).toBe(true);
      // ... but SQLite stays open until the drain resolves.
      expect(app.health()).toEqual({ status: 'degraded', database: 'ok', mcp: 'not_ready' });
      // And the drain is genuinely still pending: close() has not settled.
      expect(settled).toBe(false);

      // Releasing the barrier lets the in-flight run finish; only then
      // does close() settle and SQLite close.
      gate.resolve();
      await closing;
      expect(settled).toBe(true);
      expect(app.health()).toEqual({ status: 'degraded', database: 'error', mcp: 'not_ready' });
      expect(runSpy).toHaveBeenCalledTimes(1);
    } finally {
      gate.resolve();
      vi.restoreAllMocks();
    }
  });
});

interface Deferred {
  readonly promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function drainMicrotasks(): Promise<void> {
  let chain = Promise.resolve();
  for (let index = 0; index < 10; index += 1) chain = chain.then(() => undefined);
  return chain;
}

function pumpEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function seedQueuedTask(stateDirectory: string): string {
  return createQueuedTask(stateDirectory);
}

function createQueuedTask(stateDirectory: string): string {
  const db = openDatabase(join(stateDirectory, 'agent.sqlite'));
  try {
    runMigrations(db);
    const tasks = new TaskRepository(db);
    return tasks.create({
      goal: 'Ship the web fix',
      taskType: 'CODING',
      publishMode: 'PULL_REQUEST',
      repoSelector: 'acme/web',
    }).id;
  } finally {
    db.close();
  }
}

function readTaskStatus(stateDirectory: string, taskId: string): string | null {
  const db = openDatabase(join(stateDirectory, 'agent.sqlite'));
  try {
    runMigrations(db);
    return new TaskRepository(db).get(taskId)?.status ?? null;
  } finally {
    db.close();
  }
}

it('registers authenticated production coding tools without controller credentials or network calls', async () => {
  const app = await startAgent({ ...fixture(), port: 0, installSignalHandlers: false });
  running.push(app);
  const response = await fetch(`${app.url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-gram-agent-auth': 'integration-secret',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  expect(response.status).toBe(200);
  const tools = await response.text();
  expect(tools).toContain('coding_step_get');
  expect(tools).toContain('coding_step_submit');
  expect(tools).toContain('verification_review_get');
  expect(tools).toContain('verification_review_submit');
});

it('composes fail-closed production GitHub services without acquiring a credential at startup', async () => {
  const factory = vi.spyOn(githubServices, 'createProductionGitHubServices');
  const runnerFactory = vi.spyOn(runnerComposition, 'createTaskRunner');
  try {
    const app = await startAgent({ ...fixture(), port: 0, installSignalHandlers: false });
    running.push(app);
    expect(factory).toHaveBeenCalledOnce();
    const services = factory.mock.results[0]?.value as ReturnType<typeof githubServices.createProductionGitHubServices>;
    expect(services.pullRequests).toBeDefined();
    expect(services.checks.client).toBeDefined();
    expect(runnerFactory.mock.calls[0]?.[0].pullRequests).toBe(services.pullRequests);
    expect(runnerFactory.mock.calls[0]?.[0].checks).toBe(services.checks);
  } finally {
    factory.mockRestore();
    runnerFactory.mockRestore();
  }
});

it('shutdown interrupts a real coding wait, drains failure persistence and preserves the repository lease', async () => {
  const paths = fixture();
  const db = openDatabase(join(paths.stateDirectory, 'agent.sqlite'));
  runMigrations(db);
  const repoId = 159;
  new RepositoryRepository(db).upsert({
    githubRepositoryId: repoId,
    owner: 'fixture',
    name: 'repo',
    defaultBranch: 'main',
    localBasePath: paths.stateDirectory,
  });
  const tasks = new TaskRepository(db);
  const task = tasks.create({ repoId, goal: 'Edit source', taskType: 'FIX', publishMode: 'PULL_REQUEST' });
  const workspace = new WorkspaceRepository(db).create({
    taskId: task.id,
    repoId,
    linuxPath: join(paths.stateDirectory, 'worktree'),
    branch: 'fix/task-source',
    headSha: 'a'.repeat(40),
  });
  mkdirSync(workspace.linuxPath);
  writeFileSync(join(workspace.linuxPath, 'AGENTS.md'), 'Use tests');
  const composition = vi.spyOn(runnerComposition, 'createTaskRunner');
  const run = vi.spyOn(TaskRunner.prototype, 'run').mockImplementation(async (taskId) => {
    const options = composition.mock.calls[0]?.[0];
    if (options?.locks === undefined || options.capabilities?.instructions === undefined)
      throw new Error('Production capability not wired');
    await options.locks.acquire(repoId, taskId);
    tasks.transition(taskId, 'PREPARING', 'RUNNING');
    await options.capabilities.instructions.load(workspace, taskId);
  });
  try {
    const app = await startAgent({ ...paths, port: 0, installSignalHandlers: false });
    running.push(app);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (db.prepare("SELECT id FROM coding_steps WHERE state = 'PENDING'").get() !== undefined) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(tasks.get(task.id)?.status).toBe('RUNNING');
    expect(db.prepare("SELECT id FROM coding_steps WHERE state = 'PENDING'").get()).toBeDefined();
    await app.close();
    expect(tasks.get(task.id)?.status).toBe('FAILED');
    expect(db.prepare('SELECT state FROM coding_steps').get()).toEqual({ state: 'INTERRUPTED' });
    expect(new LockRepository(db).get(repoId)?.ownerTaskId).toBe(task.id);
    expect(app.health().database).not.toBe('ok');
  } finally {
    run.mockRestore();
    composition.mockRestore();
    db.close();
  }
});
