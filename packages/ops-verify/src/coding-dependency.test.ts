// coding-dependency.test.ts — Coding-agent dependency allowlist (D13).
//
// An operation blocked on an external Coding agent surfaces exactly one
// allowlisted code, including WAITING_DEPENDENCY — never a claimed
// CONFIRMED and never a blind retry trigger.
import { describe, expect, it } from 'vitest';
import {
  CODING_DEPENDENCY_CODES,
  mapCodingDependency,
} from './harness.js';
import type { CodingDependencyState } from './harness.js';

const states: readonly CodingDependencyState[] = ['pending', 'running', 'done', 'lost'];

describe('Coding dependency allowlist', () => {
  it('allowlist includes WAITING_DEPENDENCY', () => {
    expect(CODING_DEPENDENCY_CODES).toContain('WAITING_DEPENDENCY');
  });

  it.each(states)('state %s maps to exactly one allowlisted code', (state) => {
    const code = mapCodingDependency(state);
    expect(CODING_DEPENDENCY_CODES).toContain(code);
  });

  it('pending and running dependencies wait instead of claiming or retrying', () => {
    expect(mapCodingDependency('pending')).toBe('WAITING_DEPENDENCY');
    expect(mapCodingDependency('running')).toBe('WAITING_DEPENDENCY');
  });

  it('lost dependency surfaces UNKNOWN, never success', () => {
    expect(mapCodingDependency('lost')).toBe('UNKNOWN');
  });
});
