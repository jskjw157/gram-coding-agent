import { describe, expect, it } from 'vitest';
import { SecretRedactor } from '@gram/secrets';
import { screenLocalText } from './local-content-screen.js';

describe('native Windows credential preview screening', () => {
  it.each([
    'PASSWORD=crlf-private-canary\r\nSAFE=visible\r\n',
    'password: crlf-private-canary\r\nSAFE: visible\r\n',
    'export API_KEY="crlf-private-canary"\r\nSAFE=visible\r\n',
    'PASSWORD="crlf-private-canary\r\ncontinued-private-canary"\r\nSAFE=visible\r\n',
    'PASSWORD=crlf-private-canary\rSAFE=visible\r',
    'PASSWORD=crlf-private-canary\u2028SAFE=visible',
  ])('withholds credential assignments across native line endings: %#', content => {
    const result = screenLocalText(content, new SecretRedactor());
    expect(result.masked).toBe(true);
    expect(result.content).not.toContain('private-canary');
    if (content.includes('\r\n')) expect(result.content).toContain('SAFE');
  });

  it('preserves ordinary CRLF source bytes without classifying newline conversion as a secret', () => {
    const content = 'import { createRoot } from "react-dom/client";\r\nconst count = 1;\r\n';
    expect(screenLocalText(content, new SecretRedactor())).toEqual({ content, masked: false });
  });
});
