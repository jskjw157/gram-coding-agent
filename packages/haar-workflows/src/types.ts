/**
 * HAAR local-first product-draft workflow types (MAC-05 WP-19).
 *
 * Local-first invariants encoded in the type system:
 * - `DraftBundle.remoteMutationCount` is the literal type `0`.
 * - `DraftBundle.publication` is the literal type `'NOT_REQUESTED'`.
 * - `DraftBundle.completion` is the literal type `'REVIEW_READY'` (never published).
 *
 * There is intentionally no publish/remote-save code path in this package.
 * All data below is synthetic fixture data (`fixture-product-001`); no real
 * product data claims are made.
 */

/** The six fixed workflow steps, in order. No other step key is valid. */
export const STEP_KEYS = ['source', 'assets', 'copy', 'render', 'recheck', 'bundle'] as const;

export type StepKey = (typeof STEP_KEYS)[number];

/** A single sourced fact about the fixture product. */
export interface Fact {
  readonly id: string;
  readonly statement: string;
  readonly sourceRef: string;
  readonly digest: string;
}

/** A point-in-time snapshot of the fixture product variant. */
export interface ProductSnapshot {
  readonly productId: string;
  readonly variantKey: string;
  readonly factDigest: string;
  readonly capturedAt: string;
}

/** A fixture-approved asset bound to one product variant. */
export interface ApprovedAsset {
  readonly assetId: string;
  readonly variantKey: string;
  readonly kind: 'image' | 'copy' | 'spec';
  readonly digest: string;
  readonly approvedBy: 'fixture-approval';
}

/** Input to the draft workflow. Synthetic fixture data only. */
export interface ProductDraftInput {
  readonly productId: string;
  readonly variantKey: string;
  readonly facts: readonly Fact[];
  readonly assets: readonly ApprovedAsset[];
  readonly copyText: string;
  /** Set only to simulate a mandatory human challenge (MFA/CAPTCHA-class). */
  readonly requiresHumanChallenge?: boolean;
}

/**
 * Step readiness states.
 * - `NEEDS_INPUT`: required local data is missing (fix by supplying data).
 * - `STALE_INPUT`: a prior step's input digest drifted (fix by re-running).
 * - `WAITING_USER`: a mandatory human challenge blocks progress (nothing
 *   else unblocks it). Distinct from `NEEDS_INPUT` by construction.
 */
export type StepReadinessStatus = 'READY' | 'STALE_INPUT' | 'NEEDS_INPUT' | 'WAITING_USER';

export interface StepReadiness {
  readonly stepKey: StepKey;
  readonly status: StepReadinessStatus;
}

export interface StepResult {
  readonly stepKey: StepKey;
  readonly outcome: 'DONE' | 'REUSED';
  readonly inputDigest: string;
}

/** Publication is never requested by this local-first workflow. */
export type PublicationStatus = 'NOT_REQUESTED';

/** Local completion hands a bundle to human review; it is never published. */
export type CompletionStatus = 'REVIEW_READY';

export interface DraftBundle {
  readonly bundleId: string;
  readonly productId: string;
  readonly variantKey: string;
  readonly steps: readonly StepResult[];
  /** Instrumented remote-mutation count. Always `0` for this workflow. */
  readonly remoteMutationCount: 0;
  readonly publication: PublicationStatus;
  readonly completion: CompletionStatus;
  readonly bundleDigest: string;
}

export type HaarWorkflowErrorCode =
  | 'UNKNOWN_STEP_KEY'
  | 'VARIANT_MISMATCH'
  | 'OVERSIZE'
  | 'SCRIPT_HTML_REFUSED'
  | 'WRITE_APPROVED_REFUSED'
  | 'STALE_INPUT'
  | 'NEEDS_INPUT'
  | 'WAITING_USER';

export class HaarWorkflowError extends Error {
  readonly code: HaarWorkflowErrorCode;

  constructor(code: HaarWorkflowErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'HaarWorkflowError';
    this.code = code;
  }
}
