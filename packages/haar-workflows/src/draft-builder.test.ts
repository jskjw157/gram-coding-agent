import { describe, expect, it } from 'vitest';
import { DraftBuilder } from './draft-builder.js';
import { createMutationCounter, fixtureProductInput } from './fixture.js';
import { HaarWorkflowError } from './types.js';

function builder(): DraftBuilder {
  return new DraftBuilder({ remoteMutationPort: createMutationCounter() });
}

describe('DraftBuilder step keys', () => {
  it('exposes exactly the six fixed step keys in order', () => {
    expect([...DraftBuilder.stepKeys]).toEqual(['source', 'assets', 'copy', 'render', 'recheck', 'bundle']);
  });

  it('refuses an unknown step key', () => {
    const b = builder();
    const input = fixtureProductInput();
    expect(() => b.runStep('publish', input)).toThrowError(HaarWorkflowError);
    expect(() => b.runStep('publish', input)).toThrowError(/UNKNOWN_STEP_KEY/);
  });
});

describe('DraftBuilder input validation', () => {
  it('rejects assets bound to a different variant', () => {
    const b = builder();
    const input = fixtureProductInput();
    const drifted = {
      ...input,
      assets: input.assets.map((a) => ({ ...a, variantKey: 'variant-B' })),
    };
    expect(() => b.runStep('assets', drifted)).toThrowError(/VARIANT_MISMATCH/);
  });

  it('rejects oversize input', () => {
    const b = builder();
    const input = fixtureProductInput();
    const oversize = { ...input, copyText: 'x'.repeat(4001) };
    expect(() => b.runStep('copy', oversize)).toThrowError(/OVERSIZE/);
  });

  it('rejects copy containing script HTML', () => {
    const b = builder();
    const input = fixtureProductInput();
    const hostile = { ...input, copyText: 'Nice product <script>alert(1)</script>' };
    expect(() => b.runStep('copy', hostile)).toThrowError(/SCRIPT_HTML_REFUSED/);
  });
});

describe('DraftBuilder readiness states', () => {
  it('reports NEEDS_INPUT when source facts are missing', () => {
    const b = builder();
    const input = { ...fixtureProductInput(), facts: [] };
    expect(b.readiness('source', input).status).toBe('NEEDS_INPUT');
  });

  it('keeps WAITING_USER distinct from NEEDS_INPUT and only for human challenges', () => {
    const b = builder();
    const missing = { ...fixtureProductInput(), facts: [] };
    // Missing data is NEEDS_INPUT, never WAITING_USER.
    expect(b.readiness('source', missing).status).toBe('NEEDS_INPUT');
    expect(b.readiness('source', missing).status).not.toBe('WAITING_USER');
    // A mandatory human challenge surfaces as WAITING_USER on recheck.
    const challenged = { ...fixtureProductInput(), requiresHumanChallenge: true };
    expect(b.readiness('recheck', challenged).status).toBe('WAITING_USER');
  });

  it('reuses digest-matched steps and flags drifted input as STALE_INPUT', () => {
    const b = builder();
    const input = fixtureProductInput();
    const first = b.runStep('source', input);
    expect(first.outcome).toBe('DONE');
    const second = b.runStep('source', input);
    expect(second.outcome).toBe('REUSED');
    expect(second.inputDigest).toBe(first.inputDigest);
    const drifted = { ...input, copyText: `${input.copyText} (edited)` };
    expect(b.readiness('source', drifted).status).toBe('STALE_INPUT');
  });

  it('runs a final source recheck before bundling and blocks on drift', () => {
    const b = builder();
    const input = fixtureProductInput();
    for (const key of ['source', 'assets', 'copy', 'render', 'recheck'] as const) {
      b.runStep(key, input);
    }
    const driftedFacts = {
      ...input,
      facts: [{ id: 'fact-999', statement: 'Drifted.', sourceRef: 'x', digest: 'drift' }],
    };
    expect(() => b.finalizeBundle(driftedFacts)).toThrowError(/STALE_INPUT/);
  });
});

describe('DraftBuilder local-first invariant', () => {
  it('produces a REVIEW_READY bundle with zero remote mutations', () => {
    const counter = createMutationCounter();
    const b = new DraftBuilder({ remoteMutationPort: counter });
    const input = fixtureProductInput();
    for (const key of ['source', 'assets', 'copy', 'render', 'recheck'] as const) {
      b.runStep(key, input);
    }
    const bundle = b.finalizeBundle(input);
    expect(bundle.remoteMutationCount).toBe(0);
    expect(bundle.publication).toBe('NOT_REQUESTED');
    expect(bundle.completion).toBe('REVIEW_READY');
    expect(counter.count).toBe(0);
  });
});
