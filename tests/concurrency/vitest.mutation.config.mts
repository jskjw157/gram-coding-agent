import { defineConfig, mergeConfig } from 'vitest/config';
import normal from './vitest.config.mjs';

/**
 * Opt-in sensitivity checks for behavior already implemented at the pinned M2 HEAD.
 * Production files on disk are never edited. Normal configuration has no mutants.
 * M3_CONCURRENCY_MUTANT=<name> pnpm exec vitest run --config tests/concurrency/vitest.mutation.config.mts
 * Each run is expected to FAIL its unchanged regression assertion, then normal config must PASS.
 */
const mutations = {
  'global-queue': {
    file: '/apps/agent/src/task-scheduler.ts',
    before: 'if (this.inFlight.has(taskId)) continue;',
    after: 'if (this.inFlight.size > 0) return;',
  },
  'fail-contention': {
    file: '/apps/agent/src/task-scheduler.ts',
    before: 'if (isRepoLockedError(error)) return;',
    after: 'if (false && isRepoLockedError(error)) return;',
  },
  'release-before-confirm': {
    file: '/packages/publishing/src/publishing-service.ts',
    before: 'const confirmed = await this.options.remote.confirmRemoteSha(',
    after: 'await context.lock.release();\n    const confirmed = await this.options.remote.confirmRemoteSha(',
  },
  'release-before-record': {
    file: '/packages/publishing/src/publishing-service.ts',
    before: 'await this.options.persistence.markRemoteConfirmed(',
    after: 'await context.lock.release();\n    await this.options.persistence.markRemoteConfirmed(',
  },
  'accept-mismatch': {
    file: '/packages/publishing/src/publishing-service.ts',
    before: 'if (!confirmed) {',
    after: 'if (false && !confirmed) {',
  },
};
const selected = process.env.M3_CONCURRENCY_MUTANT;
if (selected === undefined || !Object.hasOwn(mutations, selected)) {
  throw new Error(`Select one M3_CONCURRENCY_MUTANT: ${Object.keys(mutations).join(', ')}`);
}
const mutation = mutations[selected as keyof typeof mutations];

export default mergeConfig(
  normal,
  defineConfig({
    plugins: [
      {
        name: 'm3-concurrency-sensitivity',
        enforce: 'pre',
        transform(source, id) {
          if (!id.replaceAll('\\', '/').endsWith(mutation.file)) return;
          if (source.split(mutation.before).length !== 2) throw new Error('Mutation anchor must occur exactly once');
          return { code: source.replace(mutation.before, mutation.after), map: null };
        },
      },
    ],
  }),
);
