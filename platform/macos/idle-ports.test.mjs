import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForIdlePorts } from './tests/wait-for-idle-ports.mjs';

function clock() {
  let time = 0;
  return { now: () => time, sleep: async ms => { time += ms; } };
}

test('fixture waits for residual occupied ports to become observably free', async () => {
  const time = clock(); let probes = 0;
  await waitForIdlePorts(async () => ++probes < 3
    ? { core: 'occupied', tunnel: 'free' } : { core: 'free', tunnel: 'free' }, time);
  assert.equal(probes, 3); assert.equal(time.now(), 400);
});

test('fixture never accepts persistent occupancy at its deadline', async () => {
  const time = clock();
  await assert.rejects(waitForIdlePorts(async () => ({ core: 'occupied', tunnel: 'free' }),
    { ...time, timeoutMs: 1000 }), /^Error: FIXTURE_PORTS_NOT_IDLE$/u);
  assert.equal(time.now(), 1000);
});

test('fixture refuses unknown observations without claiming completion', async () => {
  const time = clock();
  await assert.rejects(waitForIdlePorts(async () => ({ core: 'unknown', tunnel: 'free' }), time),
    /^Error: FIXTURE_PORTS_UNKNOWN$/u);
  assert.equal(time.now(), 0);
});

test('fixture refuses a free observation that arrives after its deadline', async () => {
  const time = clock();
  await assert.rejects(waitForIdlePorts(async () => {
    await time.sleep(1001);
    return { core: 'free', tunnel: 'free' };
  }, { ...time, timeoutMs: 1000 }), /^Error: FIXTURE_PORTS_NOT_IDLE$/u);
});
