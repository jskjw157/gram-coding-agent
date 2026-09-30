import type {
  ChecksClientPort,
  CiPullRequestContext,
  RequiredCheckSnapshot,
  RequiredCheckStatus,
} from './checks-service.js';
import {
  GitHubClient,
  type GitHubClientOptions,
} from './github-client.js';

interface RequiredCheckRule {
  context: string;
  appId?: number;
}

interface RequiredStatusChecksPayload {
  contexts?: unknown;
  checks?: unknown;
}

interface CheckRunPayload {
  id?: unknown;
  name?: unknown;
  head_sha?: unknown;
  status?: unknown;
  conclusion?: unknown;
  details_url?: unknown;
  started_at?: unknown;
  completed_at?: unknown;
  check_suite?: { id?: unknown } | null;
  app?: { id?: unknown } | null;
}

interface CheckRunsPayload {
  check_runs?: unknown;
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : undefined;
}

function optionalString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function requiredRules(value: unknown): RequiredCheckRule[] {
  if (value === null || typeof value !== 'object') {
    throw new Error('GitHub required status checks returned an invalid payload');
  }
  const payload = value as RequiredStatusChecksPayload;

  if (Array.isArray(payload.checks) && payload.checks.length > 0) {
    return payload.checks.map((raw) => {
      if (raw === null || typeof raw !== 'object') {
        throw new Error('GitHub required status checks returned an invalid check rule');
      }
      const rule = raw as { context?: unknown; app_id?: unknown };
      const context = nonEmptyString(rule.context);
      if (context === undefined) {
        throw new Error('GitHub required status checks returned a check without context');
      }
      if (
        rule.app_id !== undefined &&
        rule.app_id !== null &&
        typeof rule.app_id !== 'number'
      ) {
        throw new Error('GitHub required status checks returned an invalid app id');
      }
      return {
        context,
        ...(typeof rule.app_id === 'number' ? { appId: rule.app_id } : {}),
      };
    });
  }

  if (Array.isArray(payload.contexts)) {
    const rules = payload.contexts.map((raw) => {
      const context = nonEmptyString(raw);
      if (context === undefined) {
        throw new Error('GitHub required status checks returned an invalid context');
      }
      return { context };
    });
    if (rules.length > 0) return rules;
  }

  throw new Error('GitHub branch has no required status checks configured');
}

function normalizeStatus(value: unknown): RequiredCheckStatus {
  if (value === 'completed') return 'completed';
  if (value === 'in_progress') return 'in_progress';
  if (
    value === 'queued' ||
    value === 'waiting' ||
    value === 'requested' ||
    value === 'pending'
  ) {
    return 'queued';
  }
  throw new Error(`GitHub check run returned unsupported status: ${String(value)}`);
}

function appMatches(rule: RequiredCheckRule, run: CheckRunPayload): boolean {
  if (rule.appId === undefined || rule.appId === -1) return true;
  return run.app?.id === rule.appId;
}

function decodeCheckRuns(value: unknown): CheckRunPayload[] {
  if (value === null || typeof value !== 'object') {
    throw new Error('GitHub check-runs returned an invalid payload');
  }
  const payload = value as CheckRunsPayload;
  if (!Array.isArray(payload.check_runs)) {
    throw new Error('GitHub check-runs response is missing check_runs');
  }
  return payload.check_runs.map((run) => {
    if (run === null || typeof run !== 'object') {
      throw new Error('GitHub check-runs returned an invalid check entry');
    }
    return run as CheckRunPayload;
  });
}

function syntheticQueued(rule: RequiredCheckRule): RequiredCheckSnapshot {
  const suffix =
    rule.appId === undefined || rule.appId === -1 ? '' : `:${rule.appId}`;
  return {
    providerCheckId: `required:${rule.context}${suffix}`,
    checkName: rule.context,
    status: 'queued',
    conclusion: null,
  };
}

function snapshotFromRun(
  rule: RequiredCheckRule,
  run: CheckRunPayload,
  expectedHeadSha: string,
): RequiredCheckSnapshot | undefined {
  if (run.name !== rule.context) return undefined;
  if (run.head_sha !== expectedHeadSha) return undefined;
  if (!appMatches(rule, run)) return undefined;

  if (typeof run.id !== 'number' && typeof run.id !== 'string') {
    throw new Error(`GitHub required check ${rule.context} is missing an id`);
  }
  const checkName = nonEmptyString(run.name);
  if (checkName === undefined) {
    throw new Error('GitHub required check is missing a name');
  }

  const status = normalizeStatus(run.status);
  const conclusion = optionalString(run.conclusion);
  if (run.conclusion !== undefined && conclusion === undefined) {
    throw new Error(`GitHub required check ${checkName} has invalid conclusion`);
  }
  const detailsUrl = optionalString(run.details_url);
  const startedAt = optionalString(run.started_at);
  const completedAt = optionalString(run.completed_at);
  const suiteId = run.check_suite?.id;

  if (
    suiteId !== undefined &&
    suiteId !== null &&
    typeof suiteId !== 'number' &&
    typeof suiteId !== 'string'
  ) {
    throw new Error(`GitHub required check ${checkName} has invalid suite id`);
  }

  return {
    ...(suiteId === undefined || suiteId === null
      ? {}
      : { providerRunId: String(suiteId) }),
    providerCheckId: String(run.id),
    checkName,
    status,
    ...(conclusion === undefined ? {} : { conclusion }),
    ...(detailsUrl === undefined || detailsUrl === null ? {} : { url: detailsUrl }),
    ...(startedAt === undefined || startedAt === null ? {} : { startedAt }),
    ...(completedAt === undefined || completedAt === null
      ? {}
      : { finishedAt: completedAt }),
  };
}

export class GitHubChecksClient implements ChecksClientPort {
  private readonly api: GitHubClient;

  constructor(options: GitHubClientOptions) {
    this.api = new GitHubClient(options);
  }

  async listRequiredChecks(
    pullRequest: CiPullRequestContext,
  ): Promise<RequiredCheckSnapshot[]> {
    if (!/^[0-9a-f]{40}$/u.test(pullRequest.headSha)) {
      throw new Error('GitHub required-check observation requires a full lowercase HEAD SHA');
    }

    const owner = encode(pullRequest.owner);
    const repo = encode(pullRequest.name);
    const base = encode(pullRequest.baseBranch);

    let protection: unknown;
    try {
      protection = await this.api.getJson(
        `/repos/${owner}/${repo}/branches/${base}/protection/required_status_checks`,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`GitHub required status checks are unavailable: ${detail}`);
    }
    const rules = requiredRules(protection);

    const runs = decodeCheckRuns(
      await this.api.getJson(
        `/repos/${owner}/${repo}/commits/${pullRequest.headSha}/check-runs?filter=latest&per_page=100`,
      ),
    );

    return rules.map((rule) => {
      for (const run of runs) {
        const snapshot = snapshotFromRun(rule, run, pullRequest.headSha);
        if (snapshot !== undefined) return snapshot;
      }
      return syntheticQueued(rule);
    });
  }
}
