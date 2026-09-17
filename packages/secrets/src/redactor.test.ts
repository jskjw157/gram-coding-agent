import { describe, expect, it } from 'vitest';
import { SecretRedactor } from './redactor.js';

describe('SecretRedactor', () => {
  it('redacts registered exact secrets and token-shaped bearer values', () => {
    const redactor = new SecretRedactor(['super-secret-value']);

    expect(redactor.redact('x super-secret-value y')).toBe('x ***REDACTED*** y');
    const bearer = redactor.redact('Authorization: Bearer sk-test-1234567890');
    expect(bearer).not.toContain('sk-test-1234567890');
    expect(bearer).toContain('***REDACTED***');
  });

  it('redacts recursively before structured metadata reaches a sink', () => {
    const redactor = new SecretRedactor(['needle-secret']);
    expect(redactor.redactValue({ nested: ['safe', { token: 'needle-secret' }] })).toEqual({
      nested: ['safe', { token: '***REDACTED***' }],
    });
  });
});
