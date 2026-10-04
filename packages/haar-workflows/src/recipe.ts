import { HaarWorkflowError } from './types.js';
import { STEP_KEYS } from './types.js';

export const HAAR_PRODUCT_DRAFT_RECIPE_ID = 'haar.product-draft.v1' as const;

/**
 * Local-first fixture recipe. FIXTURE mode with READ_ONLY access over the
 * six fixed steps. WRITE_APPROVED approvals are refused, and no publish
 * path exists anywhere in this package by construction.
 */
export const recipeDescriptor = {
  recipeId: HAAR_PRODUCT_DRAFT_RECIPE_ID,
  mode: 'FIXTURE',
  access: 'READ_ONLY',
  steps: STEP_KEYS,
} as const;

export function evaluateApproval(approval: { kind: string }): { ok: true } {
  if (approval.kind === 'WRITE_APPROVED') {
    throw new HaarWorkflowError(
      'WRITE_APPROVED_REFUSED',
      'haar.product-draft.v1 is FIXTURE/READ_ONLY; remote writes are never approved here',
    );
  }
  if (approval.kind !== 'READ_ONLY_ACK') {
    throw new HaarWorkflowError('WRITE_APPROVED_REFUSED', `unsupported approval kind: ${approval.kind}`);
  }
  return { ok: true };
}
