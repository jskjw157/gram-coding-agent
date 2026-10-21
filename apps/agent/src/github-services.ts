import { randomUUID } from 'node:crypto';
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
import type { SmokeBoundary, SmokeBoundaryObserver, SmokeContext } from './smoke-lock-observer.js';

export interface ProductionGitHubServicesOptions {
  secrets: SecretProvider;
  pullRequests: PullRequestPersistencePort;
  evidence: PullRequestEvidencePort;
  ciRuns: CiRunPersistencePort;
  fetch?: GitHubFetch;
  observer?: SmokeBoundaryObserver;
}

// Only the GitHub adapters acquire github.token, lazily per request. Native
// requests have a finite timeout and cannot forward credentials on redirects.
const nativeGitHubFetch: GitHubFetch = (url, init) =>
  fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) });

export function createProductionGitHubServices(
  options: ProductionGitHubServicesOptions,
): { pullRequests: CompositionPullRequests; checks: CompositionChecks } {
  const baseFetch = options.fetch ?? nativeGitHubFetch;
  const scoped = (input: { taskId: string; repoId: number; headSha?: string; pullRequestId?: number }) => {
    const observer = options.observer?.repoId === input.repoId ? options.observer : undefined;
    if (observer !== undefined && (input.headSha === undefined || !/^[0-9a-f]{40}$/u.test(input.headSha))) throw new Error('Smoke observation requires HEAD SHA');
    const context: SmokeContext = { taskId: input.taskId, repoId: input.repoId, headSha: input.headSha ?? '', pullRequestId: input.pullRequestId ?? null, correlationId: randomUUID() };
    let observationFailed = false;
    const sample = (boundary: SmokeBoundary): void => {
      try { observer?.sample(context, boundary); }
      catch {
        observationFailed = true;
        throw new Error('Smoke lock observation failed');
      }
    };
    const scopedFetch: GitHubFetch = observer === undefined ? baseFetch : async (url, init) => {
      const parsed = new URL(url);
      let endpoint: SmokeBoundary['endpoint'] | undefined;
      if (parsed.pathname.endsWith('/pulls') && ['GET', 'POST'].includes(init.method)) {
        endpoint = init.method === 'POST' ? 'PR_CREATE' : 'PR_FIND';
      } else if (init.method === 'GET') {
        if (parsed.pathname.includes('/rules/branches/')) {
          endpoint = 'RULES';
        } else if (parsed.pathname.endsWith('/statuses')) {
          endpoint = 'STATUSES';
        } else if (parsed.pathname.endsWith('/protection/required_status_checks')) {
          endpoint = 'PROTECTION';
        } else if (parsed.pathname.endsWith('/check-runs')) {
          endpoint = 'CHECK_RUNS';
        }
      }
      if (endpoint === undefined) {
        observationFailed = true;
        throw new Error('Smoke lock observation failed');
      }
      const pageValue = parsed.searchParams.get('page');
      const boundary = { requestId: randomUUID(), endpoint, method: init.method, page: pageValue === null ? null : Number(pageValue) };
      sample({ ...boundary, boundary: 'BEFORE' });
      let status: number | undefined;
      try {
        const response = await baseFetch(url, init);
        status = response.status;
        return response;
      } catch {
        throw new Error('Smoke GitHub request failed');
      } finally {
        sample({ ...boundary, boundary: 'AFTER', outcome: status === undefined ? 'TRANSPORT_ERROR' : 'RESPONSE', ...(status === undefined ? {} : { status }) });
      }
    };
    const clientOptions = { secrets: options.secrets, fetch: scopedFetch };
    // GitHubClient intentionally sanitizes all fetch errors as transport errors.
    // Preserve a per-operation marker so failed measurements stay distinguishable
    // without carrying exception text or shared mutable task attribution.
    const execute = async <T>(operation: () => Promise<T>): Promise<T> => {
      try { return await operation(); }
      catch (error) {
        if (observationFailed) throw new Error('Smoke lock observation failed', { cause: error });
        throw error;
      }
    };
    return { api: new GitHubClient(clientOptions), checks: new GitHubChecksClient(clientOptions), context, observer, execute };
  };
  return {
    pullRequests: {
      async ensureForTask(task) {
        const scope = scoped(task);
        const service = new PullRequestService({ client: scope.api, metadata: new PullRequestMetadataBuilder(options.evidence), persistence: options.pullRequests });
        const pr = await scope.execute(() => service.ensureForTask(task));
        scope.observer?.bindPullRequest(scope.context, pr);
        return pr;
      },
    },
    checks: {
      client: {
        async listRequiredChecks(context) {
          if (!/^[0-9a-f]{40}$/u.test(context.headSha)) {
            throw new Error('GitHub required-check observation requires a full lowercase HEAD SHA');
          }
          if (options.observer !== undefined && (context.repoId === undefined || !Number.isSafeInteger(context.repoId) || context.repoId < 1)) {
            throw new Error('Smoke observation requires repository identity');
          }
          const { api, checks, execute } = scoped({ ...context, repoId: context.repoId ?? 0 });
          return execute(async () => {
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
          });
        },
      },
      persistence: options.ciRuns,
    },
  };
}
