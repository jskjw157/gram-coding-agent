import { afterEach, describe, expect, it } from 'vitest';
import { RepoLockedError } from '@gram/repo-lock';
import { RemotePushConfirmationError } from '@gram/publishing';
import { ConcurrencyFixture, type ControlledTask } from './fixture.js';

const REPO_ID = 41001;
let fixture: ConcurrencyFixture | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

async function startContenders(current: ConcurrencyFixture) {
  await current.addRepository(REPO_ID);
  // Names can change; both already-bound tasks must contend on the numeric ID.
  const first = current.createTask(REPO_ID, 'acme/current-name');
  const second = current.createTask(REPO_ID, 'acme/previous-name');
  current.scheduler.tick();
  expect(current.attempts.map((attempt) => attempt.taskId)).toEqual([first.id, second.id]);
  await expect(current.latestAttempt(second).pending).rejects.toBeInstanceOf(RepoLockedError);
  await first.mutation.reached.promise;
  expect(current.tasks.get(first.id)?.status).toBe('RUNNING');
  assertHeld(current, first, second);
  return { first, second };
}

function assertHeld(current: ConcurrencyFixture, owner: ControlledTask, waiter: ControlledTask): void {
  expect(current.tasks.get(waiter.id)?.status).toBe('WAITING_REPO_LOCK');
  const lease = current.locks.get(REPO_ID);
  expect(lease).toMatchObject({ ownerTaskId: owner.id });
  expect(current.lockFile(REPO_ID)).toMatchObject({ taskId: owner.id, leaseToken: lease?.leaseToken });
  expect(waiter.mutation.arrived).toBe(false);
}

async function retryBlocked(current: ConcurrencyFixture, owner: ControlledTask, waiter: ControlledTask) {
  // Check the held boundary before a retry so an early-release regression fails
  // on durable evidence instead of waiting for an incorrectly admitted task.
  assertHeld(current, owner, waiter);
  const previous = current.latestAttempt(waiter);
  current.scheduler.tick();
  const next = current.latestAttempt(waiter);
  expect(next).not.toBe(previous);
  // The exact runner promise is observed AFTER tick installed its handlers.
  // Awaiting this rejection therefore also observes scheduler finish(), without sleeps.
  await expect(next.pending).rejects.toBeInstanceOf(RepoLockedError);
  assertHeld(current, owner, waiter);
}

describe('M3 #92: same immutable GitHub repository ID', () => {
  it('keeps the contender waiting after push until exact remote confirmation, then overlaps PR/CI with mutation', async () => {
    fixture = new ConcurrencyFixture();
    const { first, second } = await startContenders(fixture);
    first.mutation.open();
    await first.confirmation.reached.promise;

    expect(fixture.tasks.get(first.id)?.status).toBe('PUBLISHING');
    const commit = fixture.commits.getLatestForTask(first.id);
    expect(commit).toMatchObject({ remoteConfirmed: false, remoteConfirmedAt: null });
    // A real push has finished, but the production ls-remote comparison is held.
    expect(await fixture.remoteSha(first)).toBe(commit?.sha);
    await retryBlocked(fixture, first, second);
    expect(first.pr.arrived).toBe(false);
    expect(first.ci.arrived).toBe(false);

    first.recording.open();
    first.confirmation.open();
    await first.pr.reached.promise;
    expect(await first.compared.promise).toBe(true);
    expect(fixture.commits.getLatestForTask(first.id)?.remoteConfirmed).toBe(true);
    expect(fixture.locks.get(REPO_ID)).toBeUndefined();
    expect(fixture.lockFile(REPO_ID)).toBeUndefined();

    fixture.scheduler.tick();
    await second.mutation.reached.promise;
    expect(fixture.tasks.get(first.id)?.status).toBe('PUBLISHING');
    expect(fixture.tasks.get(second.id)?.status).toBe('RUNNING');
    expect(fixture.locks.get(REPO_ID)?.ownerTaskId).toBe(second.id);

    first.pr.open();
    await first.ci.reached.promise;
    expect(fixture.tasks.get(second.id)?.status).toBe('RUNNING');
    expect(fixture.locks.get(REPO_ID)?.ownerTaskId).toBe(second.id);
    first.ci.open();
    await fixture.latestAttempt(first).pending;
    // Completing A's lock-free work must not release B's newer lease.
    expect(fixture.tasks.get(first.id)?.status).toBe('COMPLETED');
    expect(fixture.locks.get(REPO_ID)?.ownerTaskId).toBe(second.id);
    expect(fixture.lockFile(REPO_ID)).toMatchObject({ taskId: second.id });

    second.openAll();
    await fixture.scheduler.stop();
    expect(fixture.tasks.get(second.id)?.status).toBe('COMPLETED');
    expect(fixture.publishingEvents(first)).toEqual([
      'COMMIT_CREATED',
      'PUSH_STARTED',
      'REMOTE_PUSH_CONFIRMED',
      'REPO_LOCK_RELEASED',
    ]);
    expect(fixture.failures()).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });

  it('keeps the contender waiting while a successful SHA comparison is not yet durably recorded', async () => {
    fixture = new ConcurrencyFixture();
    const { first, second } = await startContenders(fixture);
    first.mutation.open();
    first.confirmation.open();
    await first.recording.reached.promise;

    expect(await first.compared.promise).toBe(true);
    expect(fixture.commits.getLatestForTask(first.id)).toMatchObject({
      remoteConfirmed: false,
      remoteConfirmedAt: null,
    });
    await retryBlocked(fixture, first, second);
    expect(first.pr.arrived).toBe(false);

    first.recording.open();
    await first.pr.reached.promise;
    expect(fixture.commits.getLatestForTask(first.id)?.remoteConfirmed).toBe(true);
    expect(fixture.locks.get(REPO_ID)).toBeUndefined();
    expect(fixture.lockFile(REPO_ID)).toBeUndefined();
    fixture.scheduler.tick();
    await second.mutation.reached.promise;
    expect(fixture.tasks.get(second.id)?.status).toBe('RUNNING');
    expect(fixture.locks.get(REPO_ID)?.ownerTaskId).toBe(second.id);

    first.openAll();
    second.openAll();
    await fixture.scheduler.stop();
    expect(fixture.tasks.get(first.id)?.status).toBe('COMPLETED');
    expect(fixture.tasks.get(second.id)?.status).toBe('COMPLETED');
    expect(fixture.failures()).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });

  it('retains both lock records and the waiter when the real remote SHA differs from the pushed commit', async () => {
    fixture = new ConcurrencyFixture();
    const { first, second } = await startContenders(fixture);
    first.mutation.open();
    await first.confirmation.reached.promise;
    const commit = fixture.commits.getLatestForTask(first.id);
    expect(await fixture.remoteSha(first)).toBe(commit?.sha);

    // Change only the disposable bare remote. RemoteService must discover this;
    // neither its boolean result nor the publishing decision is stubbed.
    await fixture.rewindRemote(first);
    expect(await fixture.remoteSha(first)).not.toBe(commit?.sha);
    first.openAll();
    await expect(fixture.latestAttempt(first).pending).rejects.toBeInstanceOf(RemotePushConfirmationError);

    expect(await first.compared.promise).toBe(false);
    expect(fixture.tasks.get(first.id)?.status).toBe('FAILED');
    expect(fixture.commits.getLatestForTask(first.id)).toMatchObject({
      sha: commit?.sha,
      remoteConfirmed: false,
      remoteConfirmedAt: null,
    });
    assertHeld(fixture, first, second);
    await retryBlocked(fixture, first, second);
    expect(first.pr.arrived).toBe(false);
    expect(first.ci.arrived).toBe(false);
    expect(fixture.publishingEvents(first)).toEqual(['COMMIT_CREATED', 'PUSH_STARTED']);
    expect(fixture.failures()).toEqual([{ taskId: first.id, errorName: 'RemotePushConfirmationError' }]);
    expect(fixture.errors).toHaveLength(1);
  });
});
