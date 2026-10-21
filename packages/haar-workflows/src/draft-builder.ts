import { MAX_ASSETS, MAX_COPY_CHARS, MAX_FACTS, sha256Hex } from './fixture.js';
import {
  HaarWorkflowError,
  STEP_KEYS,
  type DraftBundle,
  type ProductDraftInput,
  type StepKey,
  type StepReadiness,
  type StepResult,
} from './types.js';

export interface DraftBuilderOptions {
  /**
   * Accepted for instrumentation compatibility and never invoked: this
   * local-first workflow performs zero remote mutations by construction.
   * The instrumented counter in tests proves the port stays silent.
   */
  readonly remoteMutationPort?: { recordRemoteMutation(): void };
}

const SCRIPT_TAG_PATTERN = /<script[\s>]/iu;

function isStepKey(value: string): value is StepKey {
  return (STEP_KEYS as readonly string[]).includes(value);
}

function sourceDigest(input: ProductDraftInput): string {
  return fullInputDigest(input);
}

function assetsDigest(input: ProductDraftInput): string {
  return fullInputDigest(input);
}

function copyDigest(input: ProductDraftInput): string {
  return fullInputDigest(input);
}

function renderDigest(input: ProductDraftInput): string {
  return fullInputDigest(input);
}

function recheckDigest(input: ProductDraftInput): string {
  return fullInputDigest(input);
}

/**
 * Every step digests the full canonical input: any drift anywhere marks
 * every recorded step STALE_INPUT until it is re-run. Digest-matched
 * reuse still applies to byte-identical inputs.
 */
function fullInputDigest(input: ProductDraftInput): string {
  return sha256Hex(
    JSON.stringify({
      productId: input.productId,
      variantKey: input.variantKey,
      facts: input.facts.map((fact) => [fact.id, fact.statement, fact.sourceRef, fact.digest]),
      assets: input.assets.map((asset) => [asset.assetId, asset.variantKey, asset.kind, asset.digest]),
      copyText: input.copyText,
      challenged: input.requiresHumanChallenge ?? false,
    }),
  );
}

function digestFor(stepKey: StepKey, input: ProductDraftInput): string {
  switch (stepKey) {
    case 'source':
      return sourceDigest(input);
    case 'assets':
      return assetsDigest(input);
    case 'copy':
      return copyDigest(input);
    case 'render':
      return renderDigest(input);
    case 'recheck':
      return recheckDigest(input);
    case 'bundle':
      return renderDigest(input);
  }
}

function assertFitsLimits(input: ProductDraftInput): void {
  if (input.facts.length > MAX_FACTS || input.assets.length > MAX_ASSETS || input.copyText.length > MAX_COPY_CHARS) {
    throw new HaarWorkflowError(
      'OVERSIZE',
      `facts<=${MAX_FACTS}, assets<=${MAX_ASSETS}, copyChars<=${MAX_COPY_CHARS}`,
    );
  }
}

/**
 * Local-first draft builder over the six fixed steps.
 * Digest-matched steps are reused; drifted inputs surface as STALE_INPUT,
 * missing local data as NEEDS_INPUT, and mandatory human challenges as
 * WAITING_USER. No remote call exists on any path.
 */
export class DraftBuilder {
  static readonly stepKeys: readonly StepKey[] = STEP_KEYS;

  private readonly cache = new Map<StepKey, { inputDigest: string }>();
  private readonly remoteMutationPort: { recordRemoteMutation(): void } | undefined;

  constructor(opts?: DraftBuilderOptions) {
    // Held for instrumentation compatibility and never invoked: any call
    // would surface immediately on the test counter.
    this.remoteMutationPort = opts?.remoteMutationPort;
  }

  readiness(stepKey: StepKey, input: ProductDraftInput): StepReadiness {
    if (stepKey === 'source' && input.facts.length === 0) {
      return { stepKey, status: 'NEEDS_INPUT' };
    }
    if (stepKey === 'assets' && input.assets.length === 0) {
      return { stepKey, status: 'NEEDS_INPUT' };
    }
    if (stepKey === 'recheck' && input.requiresHumanChallenge === true) {
      return { stepKey, status: 'WAITING_USER' };
    }
    const cached = this.cache.get(stepKey);
    if (cached !== undefined && cached.inputDigest !== digestFor(stepKey, input)) {
      return { stepKey, status: 'STALE_INPUT' };
    }
    return { stepKey, status: 'READY' };
  }

  runStep(stepKey: string, input: ProductDraftInput): StepResult {
    if (!isStepKey(stepKey)) {
      throw new HaarWorkflowError('UNKNOWN_STEP_KEY', `unknown step key: ${stepKey}`);
    }
    if (stepKey === 'bundle') {
      this.finalizeBundle(input);
      return { stepKey, outcome: 'DONE', inputDigest: digestFor(stepKey, input) };
    }
    const inputDigest = digestFor(stepKey, input);
    const cached = this.cache.get(stepKey);
    if (cached !== undefined && cached.inputDigest === inputDigest) {
      return { stepKey, outcome: 'REUSED', inputDigest };
    }
    this.validateStep(stepKey, input);
    if (stepKey !== 'source' && stepKey !== 'assets' && stepKey !== 'copy') {
      this.assertDepsFresh(stepKey, input);
    }
    this.cache.set(stepKey, { inputDigest });
    return { stepKey, outcome: 'DONE', inputDigest };
  }

  /**
   * Final source recheck runs before every bundle: the source digest is
   * recomputed from raw input and compared against the recorded `source`
   * step. Any drift blocks the bundle with STALE_INPUT.
   */
  finalizeBundle(input: ProductDraftInput): DraftBundle {
    const depKeys: readonly StepKey[] = ['source', 'assets', 'copy', 'render', 'recheck'];
    for (const dep of depKeys) {
      const recorded = this.cache.get(dep);
      if (recorded === undefined) {
        throw new HaarWorkflowError('NEEDS_INPUT', `step not run yet: ${dep}`);
      }
      if (recorded.inputDigest !== digestFor(dep, input)) {
        throw new HaarWorkflowError('STALE_INPUT', `input drifted since step: ${dep}`);
      }
    }
    const freshSourceDigest = sourceDigest(input);
    const recordedSource = this.cache.get('source');
    if (recordedSource === undefined || recordedSource.inputDigest !== freshSourceDigest) {
      throw new HaarWorkflowError('STALE_INPUT', 'final source recheck failed: source drifted');
    }
    if (input.requiresHumanChallenge === true) {
      throw new HaarWorkflowError('WAITING_USER', 'human challenge must be resolved before bundling');
    }
    const steps: StepResult[] = [...depKeys].map((dep) => {
      const recorded = this.cache.get(dep);
      if (recorded === undefined) {
        throw new HaarWorkflowError('NEEDS_INPUT', `step not run yet: ${dep}`);
      }
      return { stepKey: dep, outcome: 'DONE' as const, inputDigest: recorded.inputDigest };
    });
    const bundleDigest = sha256Hex(
      JSON.stringify({ productId: input.productId, variantKey: input.variantKey, steps }),
    );
    const bundle: DraftBundle = {
      bundleId: `bundle-${bundleDigest.slice(0, 12)}`,
      productId: input.productId,
      variantKey: input.variantKey,
      steps,
      remoteMutationCount: 0,
      publication: 'NOT_REQUESTED',
      completion: 'REVIEW_READY',
      bundleDigest,
    };
    this.cache.set('bundle', { inputDigest: digestFor('bundle', input) });
    return bundle;
  }

  private validateStep(stepKey: StepKey, input: ProductDraftInput): void {
    if (stepKey === 'source' && input.facts.length === 0) {
      throw new HaarWorkflowError('NEEDS_INPUT', 'source requires at least one fact');
    }
    if (stepKey === 'assets') {
      if (input.assets.length === 0) {
        throw new HaarWorkflowError('NEEDS_INPUT', 'assets requires at least one approved asset');
      }
      for (const asset of input.assets) {
        if (asset.variantKey !== input.variantKey) {
          throw new HaarWorkflowError(
            'VARIANT_MISMATCH',
            `asset ${asset.assetId} targets ${asset.variantKey}, input is ${input.variantKey}`,
          );
        }
      }
    }
    if (stepKey === 'copy' || stepKey === 'render' || stepKey === 'recheck') {
      assertFitsLimits(input);
    }
    if (stepKey === 'copy' && SCRIPT_TAG_PATTERN.test(input.copyText)) {
      throw new HaarWorkflowError('SCRIPT_HTML_REFUSED', 'copy must not contain script HTML');
    }
    if (stepKey === 'recheck' && input.requiresHumanChallenge === true) {
      throw new HaarWorkflowError('WAITING_USER', 'mandatory human challenge blocks recheck');
    }
  }

  private assertDepsFresh(stepKey: StepKey, input: ProductDraftInput): void {
    const deps: readonly StepKey[] =
      stepKey === 'render' ? ['source', 'assets', 'copy'] : stepKey === 'recheck' ? ['source'] : [];
    for (const dep of deps) {
      const recorded = this.cache.get(dep);
      if (recorded === undefined) {
        throw new HaarWorkflowError('NEEDS_INPUT', `run ${dep} before ${stepKey}`);
      }
      if (recorded.inputDigest !== digestFor(dep, input)) {
        throw new HaarWorkflowError('STALE_INPUT', `input drifted since step: ${dep}`);
      }
    }
  }
}
