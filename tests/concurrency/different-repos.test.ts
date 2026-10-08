import { afterEach, describe, expect, it } from 'vitest';
import { ConcurrencyFixture } from './fixture.js';
import { Barrier } from './synchronization.js';

let fixture: ConcurrencyFixture | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

describe('M3 #91: different immutable GitHub repository IDs', () => {
  it('holds two tasks in RUNNING together without a global mutation queue', async () => {
    const barrier = new Barrier(2);
    fixture = new ConcurrencyFixture(barrier);
    await fixture.addRepository(41001);
    await fixture.addRepository(52002);
    const first = fixture.createTask(41001);
    const second = fixture.createTask(52002);

    fixture.scheduler.tick();
    // Fail a global dispatcher mutex promptly, before waiting at the barrier.
    expect(fixture.attempts.map((attempt) => attempt.taskId)).toEqual([first.id, second.id]);
    await barrier.reached.promise;

    expect(barrier.arrivals).toEqual(new Set([first.id, second.id]));
    expect(fixture.tasks.get(first.id)?.status).toBe('RUNNING');
    expect(fixture.tasks.get(second.id)?.status).toBe('RUNNING');
    expect(fixture.locks.get(41001)?.ownerTaskId).toBe(first.id);
    expect(fixture.locks.get(52002)?.ownerTaskId).toBe(second.id);
    expect(fixture.lockFile(41001)).toMatchObject({ taskId: first.id });
    expect(fixture.lockFile(52002)).toMatchObject({ taskId: second.id });

    fixture.scheduler.tick();
    expect(fixture.attempts).toHaveLength(2);

    barrier.open();
    first.openAll();
    second.openAll();
    await fixture.scheduler.stop();

    for (const task of [first, second]) {
      expect(fixture.tasks.get(task.id)?.status).toBe('COMPLETED');
      const commit = fixture.commits.getLatestForTask(task.id);
      expect(commit).toMatchObject({ repoId: task.repoId, remoteConfirmed: true });
      expect(await fixture.remoteSha(task)).toBe(commit?.sha);
      expect(fixture.locks.get(task.repoId)).toBeUndefined();
      expect(fixture.lockFile(task.repoId)).toBeUndefined();
    }
    expect(fixture.failures()).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
});
