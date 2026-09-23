export interface PersistedVerificationMetadata {
  name: string;
  required: boolean;
  status: string;
  hasEvidence: boolean;
}

export interface PersistedPullRequestEvidence {
  taskId: string;
  summary: string;
  rootCause?: string;
  changedPaths: readonly string[];
  verification: readonly PersistedVerificationMetadata[];
}

export interface PullRequestEvidencePort {
  readForTask(
    taskId: string,
  ): PersistedPullRequestEvidence | Promise<PersistedPullRequestEvidence>;
}

export interface PullRequestMetadata {
  title: string;
  body: string;
}

function safeTitle(summary: string): string {
  const normalized = summary.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return 'Verified task change';
  return normalized.length <= 120
    ? normalized
    : `${normalized.slice(0, 117)}...`;
}

function renderVerification(
  check: PersistedVerificationMetadata,
): string {
  const requirement = check.required ? 'required' : 'optional';
  if (check.status === 'PASS' && !check.hasEvidence) {
    return `- ${check.name}: UNVERIFIED (${requirement}; missing evidence)`;
  }
  return `- ${check.name}: ${check.status} (${requirement})`;
}

function escapePath(path: string): string {
  return path.replaceAll('\\', '/').replaceAll('`', '\\`');
}

export class PullRequestMetadataBuilder {
  constructor(private readonly evidence: PullRequestEvidencePort) {}

  async buildForTask(taskId: string): Promise<PullRequestMetadata> {
    const persisted = await this.evidence.readForTask(taskId);
    if (persisted.taskId !== taskId) {
      throw new Error('Persisted pull request evidence belongs to another task');
    }

    const sections: string[] = [
      `## Summary\n${persisted.summary}`,
    ];

    if (
      persisted.rootCause !== undefined &&
      persisted.rootCause.trim().length > 0
    ) {
      sections.push(`## Root Cause\n${persisted.rootCause.trim()}`);
    }

    const changedPaths =
      persisted.changedPaths.length === 0
        ? '- None recorded'
        : persisted.changedPaths
            .map((path) => `- \`${escapePath(path)}\``)
            .join('\n');
    sections.push(`## Changed Paths\n${changedPaths}`);

    const verification =
      persisted.verification.length === 0
        ? '- No persisted verification checks'
        : persisted.verification.map(renderVerification).join('\n');
    sections.push(`## Verification\n${verification}`);

    return {
      title: safeTitle(persisted.summary),
      body: sections.join('\n\n'),
    };
  }
}
