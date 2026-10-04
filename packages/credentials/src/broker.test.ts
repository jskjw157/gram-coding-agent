import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CredentialBroker,
  CredentialBrokerError,
  type CredentialCapability,
  type CredentialPermit,
  type CredentialUseInput,
  type FixtureLease,
  type FixtureVault,
  type ProviderOperation,
} from './broker.js';

/** Synthetic fixture values only — clearly fake, never real-shaped secrets. */
const CANARY_A = 'CANARY-FAKE-CREDENTIAL-ALPHA-001';
const CANARY_B = 'CANARY-FAKE-CREDENTIAL-BRAVO-002';

const digestOf = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

class MemoryLease implements FixtureLease {
  private disposed = false;
  constructor(private readonly material: string) {}
  withValue<T>(use: (value: string) => T): T {
    if (this.disposed) throw new Error('lease disposed');
    return use(this.material);
  }
  dispose(): void {
    this.disposed = true;
  }
}

class MemoryVault implements FixtureVault {
  locked = false;
  failMessage: string | null = null;
  constructor(private readonly store: ReadonlyMap<string, string>) {}
  async getForUse(name: string): Promise<FixtureLease> {
    if (this.locked) throw new Error('fixture vault is locked');
    if (this.failMessage !== null) throw new Error(this.failMessage);
    const material = this.store.get(name);
    if (material === undefined) throw new Error(`unknown credential ref: ${name}`);
    return new MemoryLease(material);
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

const BASE_OPERATION: ProviderOperation = {
  kind: 'shopify.product.read',
  fields: { productId: 'product-fixture-3' },
};

function makeCapability(overrides: Partial<CredentialCapability> = {}): CredentialCapability {
  return {
    capabilityId: 'capability-fixture-shop',
    credentialRef: BASE_PERMIT.credentialRef,
    recipeId: BASE_PERMIT.recipeId,
    workerId: BASE_PERMIT.workerId,
    scope: BASE_PERMIT.scope,
    execute: () => 'capability-ok',
    ...overrides,
  };
}

function setup(overrides: {
  permits?: readonly CredentialPermit[];
  capabilities?: readonly CredentialCapability[];
  locked?: boolean;
  failMessage?: string | null;
} = {}): { broker: CredentialBroker; vault: MemoryVault } {
  const vault = new MemoryVault(
    new Map([
      ['fixture-shop-token', CANARY_A],
      ['fixture-other-token', CANARY_B],
    ]),
  );
  vault.locked = overrides.locked ?? false;
  vault.failMessage = overrides.failMessage ?? null;
  const broker = new CredentialBroker({
    vault,
    permits: overrides.permits ?? [BASE_PERMIT],
    capabilities: overrides.capabilities ?? [makeCapability()],
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
  it('uses the credential via a registered capability and returns a sanitized receipt', async () => {
    const { broker } = setup();
    let observedInvocation = '';
    const brokerWithSpy = new CredentialBroker({
      vault: new MemoryVault(new Map([['fixture-shop-token', CANARY_A]])),
      permits: [BASE_PERMIT],
      capabilities: [
        makeCapability({
          execute: (invocation) => {
            observedInvocation = `${invocation.permitId}:${invocation.operation.kind}`;
            return 'used:ok';
          },
        }),
      ],
    });
    const receipt = await brokerWithSpy.credentialUse(validInput(), {
      capabilityId: 'capability-fixture-shop',
      operation: BASE_OPERATION,
    });

    expect(observedInvocation).toBe(`permit-fixture-001:${BASE_OPERATION.kind}`);
    expect(receipt.permitId).toBe(BASE_PERMIT.id);
    expect(receipt.credentialRef).toBe(BASE_PERMIT.credentialRef);
    expect(JSON.stringify(receipt)).not.toContain(CANARY_A);
    expect(receipt.resultDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(broker).toBeDefined();
  });

  it('rejects an arbitrary credential ref not bound to the permit', async () => {
    const { broker } = setup();
    const failure = await broker
      .credentialUse(validInput({ credentialRef: 'fixture-other-token' }), {
        capabilityId: 'capability-fixture-shop',
        operation: BASE_OPERATION,
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CredentialBrokerError);
    expect((failure as CredentialBrokerError).code).toBe('CREDENTIAL_REF_MISMATCH');
  });

  it('rejects use by the wrong peer (worker mismatch)', async () => {
    const { broker } = setup();
    const failure = await broker
      .credentialUse(validInput({ workerId: 'worker-intruder-99' }), {
        capabilityId: 'capability-fixture-shop',
        operation: BASE_OPERATION,
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CredentialBrokerError);
    expect((failure as CredentialBrokerError).code).toBe('PEER_MISMATCH');
  });

  it('rejects a changed permit identity (intent hash mismatch)', async () => {
    const { broker } = setup();
    const failure = await broker
      .credentialUse(validInput({ intentHash: digestOf('intent:tampered') }), {
        capabilityId: 'capability-fixture-shop',
        operation: BASE_OPERATION,
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CredentialBrokerError);
    expect((failure as CredentialBrokerError).code).toBe('IDENTITY_CHANGED');
  });

  it('rejects a changed recipe binding', async () => {
    const { broker } = setup();
    const failure = await broker
      .credentialUse(validInput({ recipeId: 'shopify.refund.create' }), {
        capabilityId: 'capability-fixture-shop',
        operation: BASE_OPERATION,
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CredentialBrokerError);
    expect((failure as CredentialBrokerError).code).toBe('RECIPE_MISMATCH');
  });

  it('rejects replay of an already-consumed permit (single-use)', async () => {
    const { broker } = setup();
    await broker.credentialUse(validInput(), {
      capabilityId: 'capability-fixture-shop',
      operation: BASE_OPERATION,
    });
    const failure = await broker
      .credentialUse(validInput(), {
        capabilityId: 'capability-fixture-shop',
        operation: BASE_OPERATION,
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CredentialBrokerError);
    expect((failure as CredentialBrokerError).code).toBe('PERMIT_REPLAY');
  });

  it('rejects expired permits', async () => {
    const expired: CredentialPermit = { ...BASE_PERMIT, id: 'permit-expired', expiresAt: Date.now() - 1 };
    const { broker } = setup({ permits: [expired] });
    const failure = await broker
      .credentialUse(validInput({ permitId: expired.id }), {
        capabilityId: 'capability-fixture-shop',
        operation: BASE_OPERATION,
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CredentialBrokerError);
    expect((failure as CredentialBrokerError).code).toBe('PERMIT_EXPIRED');
  });

  it('rejects use when the vault is locked without leaking the secret', async () => {
    const { broker } = setup({ locked: true });
    const failure = await broker
      .credentialUse(validInput(), {
        capabilityId: 'capability-fixture-shop',
        operation: BASE_OPERATION,
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CredentialBrokerError);
    expect((failure as CredentialBrokerError).code).toBe('VAULT_UNAVAILABLE');
    expect(String((failure as Error).message)).not.toContain(CANARY_A);
  });

  it('denies an unregistered capability', async () => {
    const { broker } = setup();
    const failure = await broker
      .credentialUse(validInput(), {
        capabilityId: 'capability-never-registered',
        operation: BASE_OPERATION,
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CredentialBrokerError);
    expect((failure as CredentialBrokerError).code).toBe('UNREGISTERED_CAPABILITY');
    expect(String((failure as Error).message)).not.toContain('capability-never-registered');
  });

  it('rejects a capability whose bindings do not match the permit', async () => {
    const { broker } = setup({
      capabilities: [makeCapability({ scope: 'RESOURCE:store-fixture-7:product-other-9' })],
    });
    const failure = await broker
      .credentialUse(validInput(), {
        capabilityId: 'capability-fixture-shop',
        operation: BASE_OPERATION,
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CredentialBrokerError);
    expect((failure as CredentialBrokerError).code).toBe('CAPABILITY_BINDING_MISMATCH');
  });

  it('blocks secret exfil: a capability outcome echoing the credential is rejected and never leaves', async () => {
    const { broker } = setup({
      capabilities: [makeCapability({ execute: () => `echo:${CANARY_A}` })],
    });
    const failure = await broker
      .credentialUse(validInput(), {
        capabilityId: 'capability-fixture-shop',
        operation: BASE_OPERATION,
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CredentialBrokerError);
    expect((failure as CredentialBrokerError).code).toBe('EXFIL_BLOCKED');
    expect(String((failure as Error).message)).not.toContain(CANARY_A);
  });

  it('exposes no raw-secret callback surface', async () => {
    const mod = await import('./broker.js');
    expect(mod, 'must not export a raw-secret worker callback').not.toHaveProperty('ApprovedWorker');
    const broker = setup().broker;
    const source = broker.credentialUse.toString();
    expect(source).not.toMatch(/\(\s*secret\s*[:)]/);
  });

  it('maps vault/provider failures to fixed codes without leaking raw messages', async () => {
    const rawVaultMessage = `vault exploded at backend-7 sk-FAKE1234567890 ${CANARY_A}`;
    const { broker } = setup({ failMessage: rawVaultMessage });
    const failure = await broker
      .credentialUse(validInput(), {
        capabilityId: 'capability-fixture-shop',
        operation: BASE_OPERATION,
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CredentialBrokerError);
    expect((failure as CredentialBrokerError).code).toBe('VAULT_UNAVAILABLE');
    const message = String((failure as Error).message);
    expect(message).not.toContain(rawVaultMessage);
    expect(message).not.toContain(CANARY_A);
    expect(message).not.toContain('sk-FAKE1234567890');
    expect(message).not.toContain('backend-7');
  });

  it('redacts capability failures to fixed codes without leaking raw messages', async () => {
    const rawCapabilityMessage = `provider blew up with Bearer FAKE-BEARER-TOKEN ${CANARY_B}`;
    const { broker } = setup({
      capabilities: [
        makeCapability({
          execute: () => {
            throw new Error(rawCapabilityMessage);
          },
        }),
      ],
    });
    const failure = await broker
      .credentialUse(validInput(), {
        capabilityId: 'capability-fixture-shop',
        operation: BASE_OPERATION,
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CredentialBrokerError);
    expect((failure as CredentialBrokerError).code).toBe('OPERATION_FAILED');
    const message = String((failure as Error).message);
    expect(message).not.toContain(rawCapabilityMessage);
    expect(message).not.toContain(CANARY_B);
    expect(message).not.toContain('FAKE-BEARER-TOKEN');
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
