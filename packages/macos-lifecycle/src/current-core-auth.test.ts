import { describe, expect, it } from 'vitest';
import { createCurrentCoreReader } from './current-core.js';
import { configDigest } from './config.js';
import { child, config, digest, discoveryFixture, signal } from './test-support/runtime/discovery.js';
describe('independent observer authentication refusal is not an endless retry loop', () => {
  it('latches an explicit authentication rejection for the same execution token', async () => {
    const f = await discoveryFixture(); const factory = f.deps.connections; if (!factory) throw new Error('factory');
    f.deps.connections = verifier => { const inner = factory(verifier); return {
      async openOwnedConnection(...args) { const c = await inner.openOwnedConnection(...args); if (!c) return null;
        const request = c.request.bind(c); c.request = async (...params) => {
          const value = await request(...params); return params[0] === 'initialize'
            ? { status: 401, contentType: 'application/json', body: Buffer.from('{}') } : value;
        }; return c;
      },
    }; };
    const read = createCurrentCoreReader(config(), f.deps);
    expect(await read(signal())).toBeNull(); const calls = f.secretUses(); expect(calls).toBe(1);
    expect(await read(signal())).toBeNull(); expect(f.secretUses()).toBe(calls);
    // A distinct, actually held execution is a new observation context. No reset
    // of the old reservation or provider's security policy is performed here.
    await f.execution.release(f.lease); await f.execution.acquire('core', 'g2', configDigest(config()), digest);
    await f.registration.publish(config(), child('g2')); f.setStatus({ ...f.status(), generation: 'g2' });
    expect(await read(signal())).toBeNull(); expect(f.secretUses()).toBe(calls + 1);
  });
  it.each(['yes', true, null])('does not promote malformed native verdict %s to owned', async value => {
    const f = await discoveryFixture(); f.proof.peer = async () => value as unknown as 'OWNED';
    expect(await createCurrentCoreReader(config(), f.deps)(signal())).toBeNull(); expect(f.secretUses()).toBe(0);
  });
});
