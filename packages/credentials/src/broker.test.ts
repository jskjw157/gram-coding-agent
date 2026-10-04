import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CredentialBroker,
  CredentialBrokerError,
  type CredentialPermit,
  type CredentialUseInput,
  type FixtureLease,
  type FixtureVault,
} from './broker.js';

/** Synthetic fixture values only — clearly fake, never real-shaped secrets. */
const CANARY_A = 'CANARY-FAKE-CREDENTIAL-ALPHA-001';
const CANARY_B = 'CANARY-FAKE-CREDENTIAL-BRAVO-002';

const digestOf = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

class MemoryLease implements FixtureLease {
  private disposed = false;
  constructor(private readonly secret: string) {}
  withValue<T>(use: (value: string) => T): T {
    if (this.disposed) throw new Error('lease disposed');
    return use(this.secret);
  }
  dispose(): void {
    this.disposed = true;
  }
}

class MemoryVault implements FixtureVault {
  locked = false;
  constructor(private readonly secrets: ReadonlyMap<string, string>) {}
  async getForUse(name: string): Promise<FixtureLease> {
    if (this.locked) throw new Error('fixture vault is locked');
    const secret = this.secrets.get(name);
    if (secret === undefined) throw new Error(`unknown credential ref: ${name}`);
    return new MemoryLease(secret);
  }
}

const BASE_PERMIT: CredentialPermit = {
  id: 'permit-fixture-001',
  intentHash: digestOf('intent:shopify.product.read:fixture-001'),
  credentialRef: 'fixture-shop-token',
  recipeId: 'shopify.product.read',
  requesterId: 'requester-fixture-ada',
  workerId: 'worker-fixture-01',
  scope: 'RESOURCE:store-fixture-7:product-fixture-3',
  expiresAt: Date.now() + 60_000,
};

function setup(overrides: { permits?: readonly CredentialPermit[]; locked?: boolean } = {}): {
  broker: CredentialBroker;
  vault: MemoryVault;
} {
  const vault = new MemoryVault(
    new Map([
      ['fixture-shop-token', CANARY_A],
      ['fixture-other-token', CANARY_B],
    ]),
  );
  vault.locked = overrides.locked ?? false;
  const broker = new CredentialBroker({
    vault,
    permits: overrides.permits ?? [BASE_PERMIT],
  });
  return { broker, vault };
}

function validInput(overrides: Partial<CredentialUseInput> = {}): CredentialUseInput {
  return {
    intentHash: BASE_PERMIT.intentHash,
    permitId: BASE_PERMIT.id,
    credentialRef: BASE_PERMIT.credentialRef,
    recipeId: BASE_PERMIT.recipeId,
    requesterId: BASE_PERMIT.requesterId,
    workerId: BASE_PERMIT.workerId,
    scope: BASE_PERMIT.scope,
    ...overrides,
  };
}

describe('CredentialBroker use-only boundary', () => {
  it('uses the credential inside the worker and returns a sanitized receipt', async () => {
    const { broker } = setup();
    let seenInside = '';
    const receipt = await broker.credentialUse(validInput(), (secret) => {
      seenInside = secret;
      // Worker performs business logic internally; returns a summary, never the secret.
      return `used:${secret.length}:ok`;
    });

    expect(seenInside).toBe(CANARY_A);
    expect(receipt.permitId).toBe(BASE_PERMIT.id);
    expect(receipt.credentialRef).toBe(BASE_PERMIT.credentialRef);
    expect(JSON.stringify(receipt)).not.toContain(CANARY_A);
    expect(receipt.resultDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects an arbitrary credential ref not bound to the permit', async () => {
    const { broker } = setup();
    await expect(
      broker.credentialUse(validInput({ credentialRef: 'fixture-other-token' }), () => 'ok'),
    ).rejects.toThrow(/arbitrary|not bound|unknown permit/i);
  });

  it('rejects use by the wrong peer (worker mismatch)', async () => {
    const { broker } = setup();
    await expect(
      broker.credentialUse(validInput({ workerId: 'worker-intruder-99' }), () => 'ok'),
    ).rejects.toThrow(/peer|requester|worker/i);
  });

  it('rejects a changed permit identity (intent hash mismatch)', async () => {
    const { broker } = setup();
    await expect(
      broker.credentialUse(validInput({ intentHash: digestOf('intent:tampered') }), () => 'ok'),
    ).rejects.toThrow(/changed|identity|re-approval/i);
  });

  it('rejects a changed recipe binding', async () => {
    const { broker } = setup();
    await expect(
      broker.credentialUse(validInput({ recipeId: 'shopify.refund.create' }), () => 'ok'),
    ).rejects.toThrow(/changed|recipe|re-approval/i);
  });

  it('rejects replay of an already-consumed permit (single-use)', async () => {
    const { broker } = setup();
    await broker.credentialUse(validInput(), () => 'first-use');
    await expect(broker.credentialUse(validInput(), () => 'second-use')).rejects.toThrow(
      /replay|single-use|consumed/i,
    );
  });

  it('rejects expired permits', async () => {
    const expired: CredentialPermit = { ...BASE_PERMIT, id: 'permit-expired', expiresAt: Date.now() - 1 };
    const { broker } = setup({ permits: [expired] });
    await expect(
      broker.credentialUse(validInput({ permitId: expired.id }), () => 'ok'),
    ).rejects.toThrow(/expir/i);
  });

  it('rejects use when the vault is locked without leaking the secret', async () => {
    const { broker } = setup({ locked: true });
    const failure = await broker.credentialUse(validInput(), () => 'ok').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CredentialBrokerError);
    expect(String((failure as Error).message)).toMatch(/locked|unavailable/i);
    expect(String((failure as Error).message)).not.toContain(CANARY_A);
  });

  it('rejects a worker that attempts to return the raw secret', async () => {
    const { broker } = setup();
    await expect(broker.credentialUse(validInput(), (secret) => secret)).rejects.toThrow(
      /raw secret|sanitized|must not return/i,
    );
  });

  it('exposes no secret_get/list/search API', async () => {
    const mod = await import('./index.js');
    const names = Object.keys(mod);
    expect(names).toContain('CredentialBroker');
    for (const banned of ['secret_get', 'secret_list', 'secret_search', 'getSecret', 'listSecrets']) {
      expect(names, `must not export ${banned}`).not.toContain(banned);
    }
    const broker = setup().broker;
    for (const banned of ['secret_get', 'secret_list', 'secret_search']) {
      expect(broker, `must not expose ${banned}`).not.toHaveProperty(banned);
    }
  });
});
