import { createHash } from 'node:crypto';
import type { ApprovedAsset, Fact, ProductDraftInput } from './types.js';

export const FIXTURE_PRODUCT_ID = 'fixture-product-001';
export const FIXTURE_VARIANT_KEY = 'variant-A';

export const MAX_FACTS = 32;
export const MAX_ASSETS = 16;
export const MAX_COPY_CHARS = 4000;

export function sha256Hex(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex');
}

function factDigest(id: string, statement: string): string {
  return sha256Hex(`fixture-fact|${id}|${statement}`);
}

function assetDigest(assetId: string, variantKey: string): string {
  return sha256Hex(`fixture-asset|${assetId}|${variantKey}`);
}

/**
 * Synthetic fixture input. Every value is invented for tests; no real
 * product data is claimed or referenced.
 */
export function fixtureProductInput(): ProductDraftInput {
  const facts: Fact[] = [
    {
      id: 'fact-001',
      statement: 'Synthetic fixture material: recycled test fiber.',
      sourceRef: 'fixture-source/manual',
      digest: factDigest('fact-001', 'recycled test fiber'),
    },
    {
      id: 'fact-002',
      statement: 'Synthetic fixture care: machine wash cold.',
      sourceRef: 'fixture-source/manual',
      digest: factDigest('fact-002', 'machine wash cold'),
    },
  ];
  const assets: ApprovedAsset[] = [
    {
      assetId: 'asset-001',
      variantKey: FIXTURE_VARIANT_KEY,
      kind: 'image',
      digest: assetDigest('asset-001', FIXTURE_VARIANT_KEY),
      approvedBy: 'fixture-approval',
    },
  ];
  return {
    productId: FIXTURE_PRODUCT_ID,
    variantKey: FIXTURE_VARIANT_KEY,
    facts,
    assets,
    copyText: 'Synthetic fixture copy for local review only. No real product data.',
  };
}

/** Instrumented remote-mutation counter. Must stay at 0 for this workflow. */
export interface RemoteMutationCounter {
  readonly count: number;
  recordRemoteMutation(): void;
}

export function createMutationCounter(): RemoteMutationCounter {
  let mutations = 0;
  return {
    get count(): number {
      return mutations;
    },
    recordRemoteMutation(): void {
      mutations += 1;
    },
  };
}
