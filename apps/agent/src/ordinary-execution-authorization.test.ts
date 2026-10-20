import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ordinaryExecutionAuthorization } from './ordinary-execution-authorization.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync('/tmp/gram-execution-authorization-'); roots.push(root);
  const task = { repoId: 123, status: 'VERIFYING' };
  const workspace = { id: 1, repoId: 123, linuxPath: root + '/workspace', branch: 'fix/task', recoveryState: null as string | null };
  const lease = { repoId: 123, ownerTaskId: 'task', leaseToken: randomUUID(), ownerPid: process.pid,
    ownerBootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    acquiredAt: new Date().toISOString(), leaseUntil: new Date(Date.now() + 60_000).toISOString() };
  const heldLease = { repoId: 123, taskId: 'task', leaseToken: lease.leaseToken };
  const held = new Map([['task', heldLease]]);
  const write = () => writeFileSync(join(root, '123.lock'), JSON.stringify({ taskId: 'task',
    leaseToken: lease.leaseToken, pid: lease.ownerPid, bootId: lease.ownerBootId, acquiredAt: lease.acquiredAt }), { mode: 0o600 });
  write();
  const get = ordinaryExecutionAuthorization({ tasks: { get: () => task }, workspaces: { getByTaskId: () => workspace },
    locks: { get: () => lease }, held, lockDirectory: root });
  return { root, task, workspace, lease, held, heldLease, write, get };
}
it('admits a matching live Task/workspace/SQLite/file/held-lease binding', () => {
  const f = fixture(); expect(f.get('task')?.workspace).toBe(f.workspace.linuxPath);
});
it.each(['repo', 'workspace-repo', 'held-token', 'owner-task', 'expired', 'recovery', 'file-owner'])('rejects inconsistent or expired execution binding: %s', (field) => {
  const f = fixture();
  if (field === 'repo') f.task.repoId = 124;
  if (field === 'workspace-repo') f.workspace.repoId = 124;
  if (field === 'held-token') f.heldLease.leaseToken = randomUUID();
  if (field === 'owner-task') f.lease.ownerTaskId = 'other';
  if (field === 'expired') f.lease.leaseUntil = new Date(Date.now() - 1).toISOString();
  if (field === 'recovery') f.workspace.recoveryState = 'NEEDS_RECOVERY';
  if (field === 'file-owner') writeFileSync(join(f.root, '123.lock'), JSON.stringify({ taskId: 'other' }));
  expect(f.get('task')).toBeUndefined();
});
it('changes authorization identity if the same workspace gets a new matching lease', () => {
  const f = fixture(); const before = f.get('task')?.identity;
  f.lease.leaseToken = randomUUID(); f.heldLease.leaseToken = f.lease.leaseToken; f.write();
  expect(f.get('task')?.workspace).toBe(f.workspace.linuxPath);
  expect(f.get('task')?.identity).not.toBe(before);
});
