/** RED stub: permissive placeholder the tests must reject. */
export const HAAR_PRODUCT_DRAFT_RECIPE_ID = 'haar.product-draft.v1' as const;

export const recipeDescriptor = {
  recipeId: HAAR_PRODUCT_DRAFT_RECIPE_ID,
  mode: 'UNKNOWN',
  access: 'UNKNOWN',
  steps: [] as readonly string[],
} as const;

export function evaluateApproval(_approval: { kind: string }): { ok: true } {
  return { ok: true };
}
