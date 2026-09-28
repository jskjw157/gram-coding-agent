import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, runMigrations, TaskRepository } from '@gram/persistence';
import { TaskRunner } from '@gram/task-engine';
import { startAgent, type RunningAgent } from './main.js';
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
