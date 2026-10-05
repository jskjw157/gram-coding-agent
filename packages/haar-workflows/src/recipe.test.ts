import { describe, expect, it } from 'vitest';
import * as recipeModule from './recipe.js';
import { HAAR_PRODUCT_DRAFT_RECIPE_ID, evaluateApproval, recipeDescriptor } from './recipe.js';

describe('haar.product-draft.v1 recipe', () => {
  it('is a FIXTURE/READ_ONLY recipe over the six fixed steps', () => {
    expect(HAAR_PRODUCT_DRAFT_RECIPE_ID).toBe('haar.product-draft.v1');
    expect(recipeDescriptor.recipeId).toBe('haar.product-draft.v1');
    expect(recipeDescriptor.mode).toBe('FIXTURE');
    expect(recipeDescriptor.access).toBe('READ_ONLY');
    expect([...recipeDescriptor.steps]).toEqual(['source', 'assets', 'copy', 'render', 'recheck', 'bundle']);
  });

  it('refuses WRITE_APPROVED approvals', () => {
    expect(() => evaluateApproval({ kind: 'WRITE_APPROVED' })).toThrowError(/WRITE_APPROVED_REFUSED/);
  });

  it('accepts the fixture READ_ONLY acknowledgement', () => {
    expect(evaluateApproval({ kind: 'READ_ONLY_ACK' })).toEqual({ ok: true });
  });

  it('has no publish path by construction', () => {
    expect('publish' in recipeDescriptor).toBe(false);
    expect((recipeModule as unknown as Record<string, unknown>)['publish']).toBeUndefined();
    expect(recipeDescriptor.steps).not.toContain('publish');
  });
});
