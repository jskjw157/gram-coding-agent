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
    'SAFE=visible\rPASSWORD=bare-cr-private-canary\r',
    'SAFE=visible\u2028PASSWORD=unicode-private-canary',
    'SAFE=visible\u2029PASSWORD=unicode-private-canary',
  ])('withholds credential assignments across native line endings: %#', content => {
    const result = screenLocalText(content, new SecretRedactor());
    expect(result.masked).toBe(true);
    expect(result.content).not.toContain('private-canary');
    if (content.includes('\r\n')) expect(result.content).toContain('SAFE');
  });

  it.each(['\r\n', '\r', '\u2028', '\u2029'])('preserves ordinary source line-ending bytes: %#', ending => {
    const content = `import { createRoot } from "react-dom/client";${ending}const count = 1;${ending}`;
    expect(screenLocalText(content, new SecretRedactor())).toEqual({ content, masked: false });
  });
});
