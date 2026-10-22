export interface WorkspaceAuthorization { workspace: string; identity: string }
interface TaskState { repoId: number | null; status: string; taskType?: string }
interface WorkspaceState { id: number; repoId: number; linuxPath: string; branch: string; recoveryState: string | null }
interface LeaseState { repoId: number; ownerTaskId: string; leaseToken: string; ownerPid: number; ownerBootId: string; leaseUntil: string; acquiredAt: string }
interface HeldLease { repoId: number; taskId: string; leaseToken: string }
export interface OrdinaryExecutionAuthorizationOptions {
  tasks: { get(taskId: string): TaskState | null };
  workspaces: { getByTaskId(taskId: string): WorkspaceState | undefined };
  locks: { get(repoId: number): LeaseState | undefined };
  held: ReadonlyMap<string, HeldLease>;
  lockDirectory: string;
}

export function ordinaryExecutionAuthorization(options: OrdinaryExecutionAuthorizationOptions) {
  return (taskId: string): WorkspaceAuthorization | undefined => {
    const task = options.tasks.get(taskId), workspace = options.workspaces.getByTaskId(taskId);
    const admitted = task?.status === 'VERIFYING' || (task?.taskType === 'LOCAL_COMMAND' && task.status === 'RUNNING');
    if (!admitted || !task || task.repoId === null || workspace === undefined ||
        workspace.repoId !== task.repoId || workspace.recoveryState !== null) return undefined;
    const lease = ownedExecutionLease(options, taskId, task.repoId);
    return lease === undefined ? undefined : { workspace: workspace.linuxPath,
      identity: JSON.stringify([workspace.id, workspace.branch, workspace.linuxPath, lease]) };
  };
}

/** Shared observation for typed application ports; not a grant to execute a command. */
export function ownedExecutionLease(options: Pick<OrdinaryExecutionAuthorizationOptions, 'held' | 'locks' | 'lockDirectory'>,
  taskId: string, repoId: number): string | undefined {
    let descriptor: number | undefined;
    try {
      const held = options.held.get(taskId);
      if (held === undefined || !Number.isSafeInteger(repoId) || repoId <= 0 ||
          held.taskId !== taskId || held.repoId !== repoId) return undefined;
      const lease = options.locks.get(repoId);
      if (lease === undefined || lease.repoId !== repoId || lease.ownerTaskId !== taskId ||
          lease.leaseToken !== held.leaseToken || lease.ownerPid !== process.pid ||
          !(Date.parse(lease.leaseUntil) > Date.now()) ||
          lease.ownerBootId !== readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()) return undefined;
      descriptor = openSync(join(options.lockDirectory, `${repoId}.lock`),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() ||
          (stat.mode & 0o077) !== 0 || stat.size > 4096) return undefined;
      const file = JSON.parse(readFileSync(descriptor, 'utf8')) as Record<string, unknown>;
      if (file.taskId !== taskId || file.leaseToken !== lease.leaseToken || file.pid !== lease.ownerPid ||
          file.bootId !== lease.ownerBootId || file.acquiredAt !== lease.acquiredAt) return undefined;
      return JSON.stringify([
        taskId, repoId,
        lease.leaseToken, lease.ownerPid, lease.ownerBootId, lease.acquiredAt, stat.dev, stat.ino,
      ]);
    } catch { return undefined; }
    finally { if (descriptor !== undefined) closeSync(descriptor); }
}
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
