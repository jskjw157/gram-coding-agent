import { describe, expect, it } from 'vitest';
import { SecretRedactor } from '@gram/secrets';
import { StructuredLogger } from './logger.js';

describe('StructuredLogger', () => {
  it('redacts message and nested metadata before serialization', () => {
    const lines: string[] = [];
    const logger = new StructuredLogger({
      redactor: new SecretRedactor(['super-secret-value']),
      sink: (line) => lines.push(line),
    });

    logger.info('using super-secret-value', {
      nested: { auth: 'Authorization: Bearer github_pat_1234567890abcdef' },
    });

    expect(lines).toHaveLength(1);
    const line = lines[0] ?? '';
    expect(line).not.toContain('super-secret-value');
    expect(line).not.toContain('github_pat_1234567890abcdef');
    expect(line).toContain('***REDACTED***');
  });
});
