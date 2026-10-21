import {
  GitHubChecksClient,
  GitHubClient,
  PullRequestMetadataBuilder,
  PullRequestService,
  type CiRunPersistencePort,
  type GitHubFetch,
  type PullRequestEvidencePort,
  type PullRequestPersistencePort,
} from '@gram/github';
import type { SecretProvider } from '@gram/secrets';
import type { CompositionChecks, CompositionPullRequests } from './task-runner-composition.js';

export interface ProductionGitHubServicesOptions {
  secrets: SecretProvider;
  pullRequests: PullRequestPersistencePort;
  evidence: PullRequestEvidencePort;
  ciRuns: CiRunPersistencePort;
  fetch?: GitHubFetch;
}

// Only the GitHub adapters acquire github.token, lazily per request. Native
// requests have a finite timeout and cannot forward credentials on redirects.
const nativeGitHubFetch: GitHubFetch = (url, init) =>
  fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) });

export function createProductionGitHubServices(
  options: ProductionGitHubServicesOptions,
): { pullRequests: CompositionPullRequests; checks: CompositionChecks } {
  const clientOptions = {
    secrets: options.secrets,
    fetch: options.fetch ?? nativeGitHubFetch,
  };
  const api = new GitHubClient(clientOptions);
  const checks = new GitHubChecksClient(clientOptions);
  return {
    pullRequests: new PullRequestService({
      client: api,
      metadata: new PullRequestMetadataBuilder(options.evidence),
      persistence: options.pullRequests,
    }),
    checks: {
      client: {
        async listRequiredChecks(context) {
          if (!/^[0-9a-f]{40}$/u.test(context.headSha)) {
            throw new Error('GitHub required-check observation requires a full lowercase HEAD SHA');
          }
          const repo = `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.name)}`;
          // Classic protection is not the full requirement set when rulesets
          // also apply. Until they are supported, reject any active rule.
          // An empty first page proves absence; a nonempty page already blocks.
          const rules = await api.getJson(
            `${repo}/rules/branches/${encodeURIComponent(context.baseBranch)}?per_page=100&page=1`,
          );
          if (!Array.isArray(rules) || rules.length !== 0) {
            throw new Error('GitHub active branch rulesets are unsupported or unavailable');
          }
          // A same-name legacy status can add a requirement even when its
          // Check Run passes. Do not evaluate or ignore legacy statuses: any
          // present status (including unrelated ones) blocks this narrow slice.
          const statuses = await api.getJson(
            `${repo}/commits/${context.headSha}/statuses?per_page=1&page=1`,
          );
          if (!Array.isArray(statuses) || statuses.length !== 0) {
            throw new Error('GitHub legacy commit statuses are unsupported or unavailable');
          }
          return checks.listRequiredChecks(context);
        },
      },
      persistence: options.ciRuns,
    },
  };
}
