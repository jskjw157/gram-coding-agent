import { describe, expect, it } from 'vitest';
import { decideRollbackSchema, parseClosedVersions, schemaCompatible } from './closed-schema.js';

describe('closed-schema exact-set', () => {
  it('exact set matches, order-insensitive, dupes rejected', () => {
    expect(schemaCompatible([1, 2], [[2, 1]])).toBe(true);
    expect(schemaCompatible([1, 2], [[1]])).toBe(false);
    expect(schemaCompatible([1, 1], [[1, 1]])).toBe(false);
    expect(parseClosedVersions([1, 2])).toEqual([1, 2]);
    expect(parseClosedVersions([1, 1])).toBeNull();
  });
  it('absent only with explicit empty accepted set', () => {
    expect(decideRollbackSchema({ state: 'absent', versions: null, accepted: [[]] }).ok).toBe(true);
    expect(decideRollbackSchema({ state: 'absent', versions: null, accepted: [[1]] }).ok).toBe(false);
    expect(decideRollbackSchema({ state: 'corrupt', versions: null, accepted: [[1]] }).ok).toBe(false);
  });
});
