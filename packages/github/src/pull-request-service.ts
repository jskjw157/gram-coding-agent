export interface PullRequestView {
  providerId?: string;
  number: number;
  url: string;
  headBranch: string;
  baseBranch: string;
  state: 'open' | 'closed';
}

export interface PullRequestTaskContext {
  taskId: string;
  repoId: number;
  owner: string;
  name: string;
  headBranch: string;
  baseBranch: string;
}

export interface PullRequestClientPort {
  findOpenPullRequest(input: {
    owner: string;
    name: string;
    headBranch: string;
    baseBranch: string;
  }): Promise<PullRequestView | undefined>;
  createPullRequest(input: {
    owner: string;
    name: string;
    headBranch: string;
    baseBranch: string;
    title: string;
    body: string;
  }): Promise<PullRequestView>;
}

export interface PullRequestMetadataPort {
  buildForTask(taskId: string): Promise<{
    title: string;
    body: string;
  }>;
}

export interface PullRequestPersistencePort {
  upsertForTask(input: {
    taskId: string;
    repoId: number;
    providerId?: string;
    number: number;
    url: string;
    headBranch: string;
    baseBranch: string;
    state: 'open' | 'closed';
  }): unknown;
}

export interface PullRequestServiceOptions {
  client: PullRequestClientPort;
  metadata: PullRequestMetadataPort;
  persistence: PullRequestPersistencePort;
}

function assertExactPair(
  pr: PullRequestView,
  task: PullRequestTaskContext,
): void {
  if (
    pr.headBranch !== task.headBranch ||
    pr.baseBranch !== task.baseBranch
  ) {
    throw new Error(
      `GitHub PR pair mismatch: expected ${task.headBranch} -> ${task.baseBranch}, got ${pr.headBranch} -> ${pr.baseBranch}`,
    );
  }
}

export class PullRequestService {
  constructor(private readonly options: PullRequestServiceOptions) {}

  async ensureForTask(task: PullRequestTaskContext): Promise<PullRequestView> {
    const existing = await this.options.client.findOpenPullRequest({
      owner: task.owner,
      name: task.name,
      headBranch: task.headBranch,
      baseBranch: task.baseBranch,
    });

    if (existing !== undefined) {
      assertExactPair(existing, task);
      this.persist(task, existing);
      return existing;
    }

    const metadata = await this.options.metadata.buildForTask(task.taskId);
    const created = await this.options.client.createPullRequest({
      owner: task.owner,
      name: task.name,
      headBranch: task.headBranch,
      baseBranch: task.baseBranch,
      title: metadata.title,
      body: metadata.body,
    });
    assertExactPair(created, task);
    this.persist(task, created);
    return created;
  }

  private persist(
    task: PullRequestTaskContext,
    pr: PullRequestView,
  ): void {
    this.options.persistence.upsertForTask({
      taskId: task.taskId,
      repoId: task.repoId,
      ...(pr.providerId === undefined ? {} : { providerId: pr.providerId }),
      number: pr.number,
      url: pr.url,
      headBranch: pr.headBranch,
      baseBranch: pr.baseBranch,
      state: pr.state,
    });
  }
}
