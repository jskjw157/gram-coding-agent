import { expect, it } from 'vitest';
import { createMcpHttpServer } from './server.js';
import { VerificationReviewSubmitInput } from './tools/verification-review-tools.js';
it('exposes strict authenticated read-only review tools', async () => {
  const server = await createMcpHttpServer({
    host: '127.0.0.1',
    port: 0,
    internalSecret: 'test-secret',
    verificationReviews: {
      get: () => null,
      read: () => ({}),
      submit: () => ({ accepted: true }),
      fail: () => ({ failed: true }),
    },
  });
  try {
    const rpc = (secret: string) =>
      fetch(`${server.url}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'x-gram-agent-auth': secret,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
    expect((await rpc('wrong')).status).toBe(401);
    const text = await (await rpc('test-secret')).text();
    for (const name of [
      'verification_review_get',
      'verification_review_read',
      'verification_review_submit',
      'verification_review_fail',
    ])
      expect(text).toContain(name);
    expect(() =>
      VerificationReviewSubmitInput.parse({ taskId: '018d8a73-6b4e-7000-8000-000000000001', evidenceRef: 'fake' }),
    ).toThrow();
  } finally {
    await server.close();
  }
});
