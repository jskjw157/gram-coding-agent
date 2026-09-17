import { describe, expect, it } from 'vitest';
import { verifyInternalSecret } from './auth.js';

describe('internal MCP authentication', () => {
  it('accepts only an exact shared-secret match', () => {
    expect(verifyInternalSecret('correct-secret', undefined)).toBe(false);
    expect(verifyInternalSecret('correct-secret', 'wrong')).toBe(false);
    expect(verifyInternalSecret('correct-secret', 'correct-secret')).toBe(true);
  });
});
