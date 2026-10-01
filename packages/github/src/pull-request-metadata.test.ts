import { describe, expect, it } from 'vitest';
import { PullRequestMetadataBuilder } from './pull-request-metadata.js';

const taskId = '018d8a73-6b4e-7000-8000-000000000001';

describe('PullRequestMetadataBuilder persisted evidence contract', () => {
  it('builds summary, known root cause, changed paths, and exact verification statuses from persisted evidence', async () => {
    const builder = new PullRequestMetadataBuilder({
      readForTask: async () => ({
        taskId,
        summary: 'Fix cache invalidation after profile update',
        rootCause: 'The mutation path kept the previous cache key.',
        changedPaths: ['src/cache/profile-cache.ts', 'src/profile/update.ts'],
        verification: [
          { name: 'lint', required: true, status: 'PASS', hasEvidence: true },
          { name: 'test', required: true, status: 'FAIL', hasEvidence: true },
          { name: 'browser', required: false, status: 'SKIPPED', hasEvidence: false },
        ],
      }),
    });

    const metadata = await builder.buildForTask(taskId);

    expect(metadata.title).toBe('Fix cache invalidation after profile update');
    expect(metadata.body).toContain(
      '## Summary\nFix cache invalidation after profile update',
    );
    expect(metadata.body).toContain(
      '## Root Cause\nThe mutation path kept the previous cache key.',
    );
    expect(metadata.body).toContain('- `src/cache/profile-cache.ts`');
    expect(metadata.body).toContain('- `src/profile/update.ts`');
    expect(metadata.body).toContain('- lint: PASS (required)');
    expect(metadata.body).toContain('- test: FAIL (required)');
    expect(metadata.body).toContain('- browser: SKIPPED (optional)');
  });

  it('never claims PASS when persisted PASS has no evidence', async () => {
    const builder = new PullRequestMetadataBuilder({
      readForTask: async () => ({
        taskId,
        summary: 'Fix verified publishing metadata',
        changedPaths: ['src/app.ts'],
        verification: [
          { name: 'lint', required: true, status: 'PASS', hasEvidence: false },
          { name: 'test', required: true, status: 'PASS', hasEvidence: true },
        ],
      }),
    });

    const metadata = await builder.buildForTask(taskId);

    expect(metadata.body).toContain('- lint: UNVERIFIED (required; missing evidence)');
    expect(metadata.body).not.toContain('- lint: PASS');
    expect(metadata.body).toContain('- test: PASS (required)');
  });

  it('omits Root Cause when persisted evidence does not know it', async () => {
    const builder = new PullRequestMetadataBuilder({
      readForTask: async () => ({
        taskId,
        summary: 'Documentation correction',
        changedPaths: ['docs/runbook.md'],
        verification: [
          { name: 'lint', required: true, status: 'PASS', hasEvidence: true },
        ],
      }),
    });

    const metadata = await builder.buildForTask(taskId);

    expect(metadata.body).not.toContain('## Root Cause');
  });
});
