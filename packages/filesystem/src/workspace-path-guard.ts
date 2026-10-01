import {
  lstatSync,
  realpathSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
} from 'node:path';
import type { TaskId } from '@gram/domain';
import type { WorkspaceRepository } from '@gram/persistence';

export class WorkspaceNotRegisteredError extends Error {
  constructor(taskId: TaskId) {
    super(`Workspace not registered for task ${taskId}`);
    this.name = 'WorkspaceNotRegisteredError';
  }
}

export class WorkspacePathEscapeError extends Error {
  constructor(path: string) {
    super(`Path escapes the task workspace: ${path}`);
    this.name = 'WorkspacePathEscapeError';
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function nearestExistingPath(target: string): string {
  let current = target;
  while (true) {
    try {
      lstatSync(current);
      return current;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'ENOENT')) {
        throw error;
      }
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

export class WorkspacePathGuard {
  constructor(private readonly workspaces: WorkspaceRepository) {}

  private workspaceRoot(taskId: TaskId): string {
    const workspace = this.workspaces.getByTaskId(taskId);
    if (workspace === undefined) throw new WorkspaceNotRegisteredError(taskId);
    return realpathSync(workspace.linuxPath);
  }

  private lexicalTarget(taskId: TaskId, relativePath: string): {
    root: string;
    target: string;
  } {
    if (relativePath.length === 0 || relativePath.includes('\0') || isAbsolute(relativePath)) {
      throw new WorkspacePathEscapeError(relativePath);
    }

    const root = this.workspaceRoot(taskId);
    const target = resolve(root, relativePath);
    if (!isWithin(root, target)) throw new WorkspacePathEscapeError(relativePath);
    return { root, target };
  }

  resolveExisting(taskId: TaskId, relativePath: string): string {
    const { root, target } = this.lexicalTarget(taskId, relativePath);
    const canonicalTarget = realpathSync(target);
    if (!isWithin(root, canonicalTarget)) throw new WorkspacePathEscapeError(relativePath);
    return canonicalTarget;
  }

  resolveForWrite(taskId: TaskId, relativePath: string): string {
    const { root, target } = this.lexicalTarget(taskId, relativePath);
    const existing = nearestExistingPath(target);

    let canonicalExisting: string;
    try {
      canonicalExisting = realpathSync(existing);
    } catch {
      throw new WorkspacePathEscapeError(relativePath);
    }

    if (!isWithin(root, canonicalExisting)) {
      throw new WorkspacePathEscapeError(relativePath);
    }
    return target;
  }
}
