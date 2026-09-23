import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskId } from "@gram/domain";
import {
  AuditRepository,
  openDatabase,
  runMigrations,
  TaskRepository,
} from "@gram/persistence";
import { TaskRunner, type TaskRunnerOptions } from "./task-runner.js";
import type {
  AnalyzePort,
  CiObservePort,
  CompletePort,
  InstructionsPort,
  ModifyPort,
  PrEnsurePort,
  PublishPort,
  RepoFetchPort,
  RepoResolvePort,
  TaskCiOutcome,
  VerifyPort,
  WorkspaceCreatePort,
} from "./task-runner-ports.js";
import { TaskService } from "./task-service.js";

type RunEvent =
  | "repo.resolve"
  | "lock.acquire"
  | "repo.fetch"
  | "workspace.create"
  | "instructions.load"
  | "analyze"
  | "modify"
  | "verify"
  | "commit"
  | "push"
  | "remote.confirm"
  | "lock.release"
  | "pr.ensure"
  | "ci.observe"
  | "complete";

interface RunCalls {
  resolve: number;
  acquire: number;
  fetch: number;
  create: number;
  load: number;
  analyze: number;
  modify: number;
  verify: number;
  commit: number;
  push: number;
  confirm: number;
  release: number;
  pr: number;
  observe: number;
  complete: number;
}

function createRunCalls(): RunCalls {
  return {
    resolve: 0,
    acquire: 0,
    fetch: 0,
    create: 0,
    load: 0,
    analyze: 0,
    modify: 0,
    verify: 0,
    commit: 0,
    push: 0,
    confirm: 0,
    release: 0,
    pr: 0,
    observe: 0,
    complete: 0,
  };
}

interface RunControls {
  verifyError?: Error;
  publishError?: Error;
  confirmResult?: boolean;
  prError?: Error;
  ciOutcome?: TaskCiOutcome;
}

interface RunDeps {
  audit: AuditRepository;
  repoResolve: RepoResolvePort;
  locks: { acquire(repoId: number, taskId: TaskId): Promise<{ release(): Promise<void> }> };
  repoFetch: RepoFetchPort;
  workspaceCreate: WorkspaceCreatePort;
  instructions: InstructionsPort;
  analyze: AnalyzePort;
  modify: ModifyPort;
  verify: VerifyPort;
  publish: PublishPort;
  prEnsure: PrEnsurePort;
  ciObserve: CiObservePort;
  complete: CompletePort;
}

const REPO_ID = 84722133;
const BRANCH = "fix/task-0201-excel-download-url";
const REMOTE = "origin";
const LOCAL_BASE_PATH = "/base/mamf-web";
const SHA = "a91c34f0a91c34f0a91c34f0a91c34f0a91c34f0";
const LINUX_PATH = "/home/agent/.gram-agent/worktrees/84722133/task-uuid";

function createRunDeps(
  audit: AuditRepository,
  taskId: string,
  events: RunEvent[],
  calls: RunCalls,
  controls: RunControls = {},
): RunDeps {
  return {
    audit,
    repoResolve: {
      resolve: async (id: TaskId) => {
        calls.resolve += 1;
        events.push("repo.resolve");
        return { taskId: id, repoId: REPO_ID, branch: BRANCH, remote: REMOTE, localBasePath: LOCAL_BASE_PATH };
      },
    },
    locks: {
      acquire: async () => {
        calls.acquire += 1;
        events.push("lock.acquire");
        return {
          release: async (): Promise<void> => {
            calls.release += 1;
            events.push("lock.release");
          },
        };
      },
    },
    repoFetch: {
      fetch: async (): Promise<void> => {
        calls.fetch += 1;
        events.push("repo.fetch");
      },
    },
    workspaceCreate: {
      create: async () => {
        calls.create += 1;
        events.push("workspace.create");
        return { linuxPath: LINUX_PATH, branch: BRANCH };
      },
    },
    instructions: {
      load: async () => {
        calls.load += 1;
        events.push("instructions.load");
        return { content: "# instructions", source: "AGENTS.md" };
      },
    },
    analyze: {
      analyze: async () => {
        calls.analyze += 1;
        events.push("analyze");
        return { summary: "fix excel url", files: ["src/app.ts"] };
      },
    },
    modify: {
      modify: async () => {
        calls.modify += 1;
        events.push("modify");
        return { sha: SHA };
      },
    },
    verify: {
      verify: async () => {
        calls.verify += 1;
        events.push("verify");
        if (controls.verifyError !== undefined) throw controls.verifyError;
        return { passed: true, output: "ok" };
      },
    },
    publish: {
      publish: async (task, _workspace, _verification, lease) => {
        calls.commit += 1;
        events.push("commit");
        if (controls.publishError !== undefined) throw controls.publishError;
        calls.push += 1;
        events.push("push");
        calls.confirm += 1;
        events.push("remote.confirm");
        const confirmed: boolean = controls.confirmResult ?? true;
        if (!confirmed) {
          throw new Error(`remote confirm failed: ${REMOTE} ${BRANCH} ${SHA}`);
        }
        await lease.release();
        return { taskId: task.taskId, sha: SHA, branch: task.branch, remote: task.remote };
      },
    },
    prEnsure: {
      ensure: async () => {
        calls.pr += 1;
        events.push("pr.ensure");
        if (controls.prError !== undefined) throw controls.prError;
        return { number: 7, url: "https://example.com/pr/7" };
      },
    },
    ciObserve: {
      observe: async () => {
        calls.observe += 1;
        events.push("ci.observe");
        return controls.ciOutcome ?? "SUCCESS";
      },
    },
    complete: {
      complete: async (): Promise<void> => {
        calls.complete += 1;
        events.push("complete");
      },
    },
  };
}

function createRunner(audit: AuditRepository, deps: RunDeps): TaskRunner {
  const combined: unknown = { ...deps, audit };
  return new TaskRunner(combined as TaskRunnerOptions);
}

const tempDirs: string[] = [];
const openDbs: Array<{ close(): void }> = [];

async function openFixtureTaskId(): Promise<{ taskId: string; audit: AuditRepository }> {
  const dir: string = mkdtempSync(join(tmpdir(), "gram-task-runner-run-"));
  tempDirs.push(dir);
  const db = openDatabase(join(dir, "state.db"));
  openDbs.push(db);
  runMigrations(db);
  const service = new TaskService(new TaskRepository(db), new AuditRepository(db));
  const task = await service.create({ repo: "mamf-web", goal: "Fix Excel download URL" });
  return { taskId: task.id, audit: new AuditRepository(db) };
}

afterEach(() => {
  while (openDbs.length > 0) openDbs.pop()?.close();
  let dir: string | undefined;
  while ((dir = tempDirs.pop()) !== undefined) rmSync(dir, { recursive: true, force: true });
});

const expectedHappyOrder: RunEvent[] = [
  "repo.resolve",
  "lock.acquire",
  "repo.fetch",
  "workspace.create",
  "instructions.load",
  "analyze",
  "modify",
  "verify",
  "commit",
  "push",
  "remote.confirm",
  "lock.release",
  "pr.ensure",
  "ci.observe",
  "complete",
];

describe("TaskRunner.run", () => {
  it("runs the exact happy-path order and completes only on success", async () => {
    const fixture = await openFixtureTaskId();
    const events: RunEvent[] = [];
    const calls: RunCalls = createRunCalls();
    const deps: RunDeps = createRunDeps(fixture.audit, fixture.taskId, events, calls);
    const runner: TaskRunner = createRunner(fixture.audit, deps);

    await runner.run(fixture.taskId);

    expect(events).toEqual(expectedHappyOrder);
    expect(calls).toMatchObject({
      resolve: 1,
      acquire: 1,
      fetch: 1,
      create: 1,
      load: 1,
      analyze: 1,
      modify: 1,
      verify: 1,
      commit: 1,
      push: 1,
      confirm: 1,
      release: 1,
      pr: 1,
      observe: 1,
      complete: 1,
    });
  });

  it("prevents publication when verification rejects", async () => {
    const fixture = await openFixtureTaskId();
    const events: RunEvent[] = [];
    const calls: RunCalls = createRunCalls();
    const deps: RunDeps = createRunDeps(fixture.audit, fixture.taskId, events, calls, {
      verifyError: new Error("verification failed"),
    });
    const runner: TaskRunner = createRunner(fixture.audit, deps);

    await expect(runner.run(fixture.taskId)).rejects.toThrow("verification failed");

    expect(events).toEqual([
      "repo.resolve",
      "lock.acquire",
      "repo.fetch",
      "workspace.create",
      "instructions.load",
      "analyze",
      "modify",
      "verify",
    ]);
    expect(calls.commit).toBe(0);
    expect(calls.push).toBe(0);
    expect(calls.confirm).toBe(0);
    expect(calls.release).toBe(0);
    expect(calls.pr).toBe(0);
    expect(calls.observe).toBe(0);
    expect(calls.complete).toBe(0);
  });

  it("prevents PR and CI when publication rejects", async () => {
    const fixture = await openFixtureTaskId();
    const events: RunEvent[] = [];
    const calls: RunCalls = createRunCalls();
    const deps: RunDeps = createRunDeps(fixture.audit, fixture.taskId, events, calls, {
      publishError: new Error("publish failed"),
    });
    const runner: TaskRunner = createRunner(fixture.audit, deps);

    await expect(runner.run(fixture.taskId)).rejects.toThrow("publish failed");

    expect(calls.commit).toBe(1);
    expect(calls.release).toBe(0);
    expect(calls.pr).toBe(0);
    expect(calls.observe).toBe(0);
    expect(calls.complete).toBe(0);
    expect(events).not.toContain("pr.ensure");
    expect(events).not.toContain("ci.observe");
    expect(events).not.toContain("complete");
  });

  it("leaves the lease held when remote confirmation fails", async () => {
    const fixture = await openFixtureTaskId();
    const events: RunEvent[] = [];
    const calls: RunCalls = createRunCalls();
    const deps: RunDeps = createRunDeps(fixture.audit, fixture.taskId, events, calls, {
      confirmResult: false,
    });
    const runner: TaskRunner = createRunner(fixture.audit, deps);

    await expect(runner.run(fixture.taskId)).rejects.toThrow("remote confirm failed");

    expect(events).toEqual([
      "repo.resolve",
      "lock.acquire",
      "repo.fetch",
      "workspace.create",
      "instructions.load",
      "analyze",
      "modify",
      "verify",
      "commit",
      "push",
      "remote.confirm",
    ]);
    expect(calls.release).toBe(0);
    expect(calls.pr).toBe(0);
    expect(calls.observe).toBe(0);
    expect(calls.complete).toBe(0);
  });

  it("rejects from PR only after the lease is released", async () => {
    const fixture = await openFixtureTaskId();
    const events: RunEvent[] = [];
    const calls: RunCalls = createRunCalls();
    const deps: RunDeps = createRunDeps(fixture.audit, fixture.taskId, events, calls, {
      prError: new Error("pr failed"),
    });
    const runner: TaskRunner = createRunner(fixture.audit, deps);

    await expect(runner.run(fixture.taskId)).rejects.toThrow("pr failed");

    expect(calls.release).toBe(1);
    expect(calls.pr).toBe(1);
    expect(calls.observe).toBe(0);
    expect(calls.complete).toBe(0);
    expect(events.indexOf("lock.release")).toBeLessThan(events.indexOf("pr.ensure"));
  });

  it("leaves the lease released but does not complete on CI PENDING", async () => {
    const fixture = await openFixtureTaskId();
    const events: RunEvent[] = [];
    const calls: RunCalls = createRunCalls();
    const deps: RunDeps = createRunDeps(fixture.audit, fixture.taskId, events, calls, {
      ciOutcome: "PENDING",
    });
    const runner: TaskRunner = createRunner(fixture.audit, deps);

    await runner.run(fixture.taskId);

    expect(calls.release).toBe(1);
    expect(calls.pr).toBe(1);
    expect(calls.observe).toBe(1);
    expect(calls.complete).toBe(0);
    expect(events).not.toContain("complete");
  });

  it("does not complete on CI FAILURE", async () => {
    const fixture = await openFixtureTaskId();
    const events: RunEvent[] = [];
    const calls: RunCalls = createRunCalls();
    const deps: RunDeps = createRunDeps(fixture.audit, fixture.taskId, events, calls, {
      ciOutcome: "FAILURE",
    });
    const runner: TaskRunner = createRunner(fixture.audit, deps);

    await runner.run(fixture.taskId);

    expect(calls.release).toBe(1);
    expect(calls.observe).toBe(1);
    expect(calls.complete).toBe(0);
    expect(events).not.toContain("complete");
  });
});
