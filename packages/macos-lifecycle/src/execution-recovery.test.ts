import { describe, expect, it } from 'vitest';
import { ExecutionLeaseStore, type ExecutionRecord } from './execution-lease.js';
import { MemoryExecutionFiles, configDigest, releaseDigest } from './test-support/execution-fixture.js';

type RecoverableStore = ExecutionLeaseStore & {
  recoverStopped?: (role: 'core' | 'tunnel',
    verify: (record: Readonly<ExecutionRecord>) => Promise<boolean>) => Promise<void>;
};

async function setup() {
  const files = new MemoryExecutionFiles();
  const store = new ExecutionLeaseStore(files) as RecoverableStore;
  await store.initializeNew('core');
  return { files, store };
}
async function recover(store: RecoverableStore,
  verify: (record: Readonly<ExecutionRecord>) => Promise<boolean>) {
  expect(store.recoverStopped).toBeTypeOf('function');
  if (!store.recoverStopped) throw new Error('RECOVERY_MISSING');
  return store.recoverStopped('core', verify);
}

describe('stopped execution recovery', () => {
  it('frees only the exact held record after literal stopped proof', async () => {
    const { store } = await setup();
    await store.acquire('core', 'g1', configDigest, releaseDigest);
    let observed: ExecutionRecord | null = null;
    await recover(store, async record => {
      observed = record;
      expect(Object.isFrozen(record)).toBe(true);
      return true;
    });
    expect(observed).toMatchObject({ role: 'core', state: 'HELD', revision: 1, generation: 'g1' });
    expect(await store.read('core')).toMatchObject({ state: 'FREE', revision: 2, generation: 'g1' });
  });

  it('rejects false or truthy non-boolean stopped evidence without mutation', async () => {
    for (const verdict of [false, 'YES' as unknown as boolean]) {
      const { store } = await setup();
      await store.acquire('core', 'g1', configDigest, releaseDigest);
      await expect(recover(store, async () => verdict)).rejects.toThrow(/^BUSY$/);
      expect(await store.read('core')).toMatchObject({ state: 'HELD', revision: 1, generation: 'g1' });
    }
  });

  it('does not recover a free record', async () => {
    const { store } = await setup();
    await expect(recover(store, async () => true)).rejects.toThrow(/^BUSY$/);
    expect(await store.read('core')).toMatchObject({ state: 'FREE', revision: 0 });
  });

  it('does not let stale stopped proof overwrite a newer owner', async () => {
    const { store } = await setup();
    const old = await store.acquire('core', 'g1', configDigest, releaseDigest);
    await expect(recover(store, async () => {
      await store.release(old);
      await store.acquire('core', 'g2', configDigest, releaseDigest);
      return true;
    })).rejects.toThrow(/^STATE_CONFLICT$/);
    expect(await store.read('core')).toMatchObject({ state: 'HELD', revision: 3, generation: 'g2' });
  });

  it('maps verifier exceptions to fixed state errors and preserves the held slot', async () => {
    const { store } = await setup();
    await store.acquire('core', 'g1', configDigest, releaseDigest);
    await expect(recover(store, async () => { throw new Error('SYNTHETIC_PRIVATE_PATH'); }))
      .rejects.toThrow(/^STATE_IO$/);
    expect(await store.read('core')).toMatchObject({ state: 'HELD', revision: 1 });
  });
});
