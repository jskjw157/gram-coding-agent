import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const path = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (p) => !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..'),
  );
export const VerificationReviewIdentityInput = z
  .object({
    taskId: z.string().uuid(),
    reviewId: z.string().uuid(),
    workspaceId: z.number().int().positive(),
    planId: z.number().int().positive(),
    checkId: z.number().int().positive(),
    headSha: z.string().regex(/^[a-f0-9]{40}$/),
    snapshotDigest: hash,
  })
  .strict();
export const VerificationReviewReadInput = VerificationReviewIdentityInput.extend({ path }).strict();
export const VerificationReviewSubmitInput = VerificationReviewIdentityInput.extend({
  status: z.enum(['PASS', 'FAIL']),
  acknowledgements: z.array(z.object({ path, digest: hash }).strict()).max(100),
  approvedPaths: z.array(path).max(100),
}).strict();
export type VerificationReviewIdentity = z.infer<typeof VerificationReviewIdentityInput>;
export type VerificationReviewRead = z.infer<typeof VerificationReviewReadInput>;
export type VerificationReviewSubmission = z.infer<typeof VerificationReviewSubmitInput>;
export interface VerificationReviewPort {
  get(taskId: string): unknown;
  read(input: VerificationReviewRead): unknown;
  submit(input: VerificationReviewSubmission): unknown;
  fail(input: VerificationReviewIdentity): unknown;
}
export function registerVerificationReviewTools(server: McpServer, port: VerificationReviewPort): void {
  const response = async (value: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(await value) }],
  });
  server.registerTool(
    'verification_review_get',
    {
      description: 'Get the active read-only verification review for a task.',
      inputSchema: z.object({ taskId: z.string().uuid() }).strict(),
    },
    ({ taskId }) => response(port.get(taskId)),
  );
  server.registerTool(
    'verification_review_read',
    {
      description: 'Read an exact before/after snapshot candidate and its single-review digest.',
      inputSchema: VerificationReviewReadInput,
    },
    (input) => response(port.read(input)),
  );
  server.registerTool(
    'verification_review_submit',
    {
      description:
        'Accept or reject a single-use verification review; PASS requires every candidate read and acknowledged.',
      inputSchema: VerificationReviewSubmitInput,
    },
    (input) => response(port.submit(input)),
  );
  server.registerTool(
    'verification_review_fail',
    {
      description: 'Fail a pending verification review without releasing the repository lease.',
      inputSchema: VerificationReviewIdentityInput,
    },
    (input) => response(port.fail(input)),
  );
}
