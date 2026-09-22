export interface VerificationCompletionPort {
  assertPassed(taskId: string): void | Promise<void>;
}

export interface PublishingCommitPort {
  commitExplicit(
    worktree: string,
    paths: readonly string[],
    message: string,
  ): Promise<string>;
}

export interface PublishingRemotePort {
  push(worktree: string, branch: string): Promise<void>;
  confirmRemoteSha(
    remote: string,
    branch: string,
    expectedSha: string,
  ): Promise<boolean>;
}

export interface PublishingPersistencePort {
  recordCommit(input: {
    taskId: string;
    repoId: number;
    sha: string;
    branch: string;
    remoteName: string;
  }): number | Promise<number>;
  markRemoteConfirmed(
    commitId: number,
    confirmedAt: string,
  ): void | Promise<void>;
}

export interface PublishingAuditPort {
  append(event: {
    taskId: string;
    eventType: string;
    payload?: unknown;
    createdAt?: string;
  }): unknown;
}

export interface PublishingLockLease {
  release(): Promise<void>;
}

export interface PublishingTaskContext {
  taskId: string;
  repoId: number;
  worktree: string;
  branch: string;
  paths: readonly string[];
  commitMessage: string;
  remote: string;
  lock: PublishingLockLease;
}

export interface PublishedCommit {
  commitId: number;
  taskId: string;
  repoId: number;
  sha: string;
  branch: string;
  remote: string;
  remoteConfirmedAt: string;
}

export interface PublishingServiceOptions {
  verification: VerificationCompletionPort;
  commits: PublishingCommitPort;
  remote: PublishingRemotePort;
  persistence: PublishingPersistencePort;
  audit: PublishingAuditPort;
  now?: () => Date;
}

export class RemotePushConfirmationError extends Error {
  constructor(
    readonly remote: string,
    readonly branch: string,
    readonly expectedSha: string,
  ) {
    super(
      `Remote ${remote} did not confirm ${expectedSha} at refs/heads/${branch}`,
    );
    this.name = 'RemotePushConfirmationError';
  }
}

export class PublishingService {
  private readonly now: () => Date;

  constructor(private readonly options: PublishingServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async publish(context: PublishingTaskContext): Promise<PublishedCommit> {
    await this.options.verification.assertPassed(context.taskId);

    const sha = await this.options.commits.commitExplicit(
      context.worktree,
      context.paths,
      context.commitMessage,
    );
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error('Commit service returned an invalid full Git SHA');
    }

    const commitId = await this.options.persistence.recordCommit({
      taskId: context.taskId,
      repoId: context.repoId,
      sha,
      branch: context.branch,
      remoteName: context.remote,
    });
    this.options.audit.append({
      taskId: context.taskId,
      eventType: 'COMMIT_CREATED',
      payload: { commitId, sha, branch: context.branch },
    });

    this.options.audit.append({
      taskId: context.taskId,
      eventType: 'PUSH_STARTED',
      payload: { sha, branch: context.branch, remote: context.remote },
    });
    await this.options.remote.push(context.worktree, context.branch);

    const confirmed = await this.options.remote.confirmRemoteSha(
      context.remote,
      context.branch,
      sha,
    );
    if (!confirmed) {
      throw new RemotePushConfirmationError(
        context.remote,
        context.branch,
        sha,
      );
    }

    const remoteConfirmedAt = this.now().toISOString();
    await this.options.persistence.markRemoteConfirmed(
      commitId,
      remoteConfirmedAt,
    );
    this.options.audit.append({
      taskId: context.taskId,
      eventType: 'REMOTE_PUSH_CONFIRMED',
      payload: {
        commitId,
        sha,
        branch: context.branch,
        remote: context.remote,
        remoteConfirmedAt,
      },
      createdAt: remoteConfirmedAt,
    });

    await context.lock.release();

    const releasedAt = this.now().toISOString();
    this.options.audit.append({
      taskId: context.taskId,
      eventType: 'REPO_LOCK_RELEASED',
      payload: {
        repoId: context.repoId,
        commitId,
        sha,
        remoteConfirmedAt,
      },
      createdAt: releasedAt,
    });

    return {
      commitId,
      taskId: context.taskId,
      repoId: context.repoId,
      sha,
      branch: context.branch,
      remote: context.remote,
      remoteConfirmedAt,
    };
  }
}
