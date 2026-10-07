import { join } from 'node:path';
import type { RepositoryRepository, StoredRepository } from '@gram/persistence';
import type { RepositoryInspection, RepositoryProjectProfile } from './repo-profiler.js';
import { RepositoryProfiler } from './repo-profiler.js';

export interface DiscoveredRepository {
  githubRepositoryId: number;
  owner: string;
  name: string;
  defaultBranch: string;
  cloneUrl: string;
}

export interface GitHubRepositoryDiscoveryPort {
  discover(selector: string): Promise<DiscoveredRepository>;
}

export interface GitCheckoutPort {
  ensureBaseCheckout(repository: DiscoveredRepository, localBasePath: string): Promise<void>;
}

export interface RepositoryInspectorPort {
  inspect(localBasePath: string): Promise<RepositoryInspection>;
}

export interface RepositoryProfile extends RepositoryProjectProfile {
  githubRepositoryId: number;
  owner: string;
  name: string;
  defaultBranch: string;
  localBasePath: string;
}

export interface RepoResolverOptions {
  repositories: RepositoryRepository;
  discovery: GitHubRepositoryDiscoveryPort;
  checkout: GitCheckoutPort;
  inspector: RepositoryInspectorPort;
  profiler?: RepositoryProfiler;
  homeDir: string;
}

function fromStored(stored: StoredRepository): RepositoryProfile {
  return {
    githubRepositoryId: stored.githubRepositoryId,
    owner: stored.owner,
    name: stored.name,
    defaultBranch: stored.defaultBranch,
    localBasePath: stored.localBasePath,
    ...(stored.projectType === undefined ? {} : { projectType: stored.projectType }),
    ...(stored.language === undefined ? {} : { language: stored.language }),
    ...(stored.packageManager === undefined ? {} : { packageManager: stored.packageManager }),
    commands: stored.commands,
    profile: stored.profile,
  };
}

export class RepoResolver {
  private readonly profiler: RepositoryProfiler;

  constructor(private readonly options: RepoResolverOptions) {
    this.profiler = options.profiler ?? new RepositoryProfiler();
  }

  async resolve(selector: string): Promise<RepositoryProfile> {
    const normalized = selector.trim();
    if (normalized.length === 0) throw new Error('Repository selector must not be empty');

    const registered = this.options.repositories.findBySelector(normalized);
    if (registered !== undefined) return fromStored(registered);

    const discovered = await this.options.discovery.discover(normalized);
    const byId = this.options.repositories.getById(discovered.githubRepositoryId);
    if (byId !== undefined) return fromStored(byId);

    const localBasePath = join(
      this.options.homeDir,
      'workspace',
      'github',
      discovered.owner,
      discovered.name,
    );
    await this.options.checkout.ensureBaseCheckout(discovered, localBasePath);
    const inspection = await this.options.inspector.inspect(localBasePath);
    const profiled = this.profiler.profile(inspection);

    const stored = this.options.repositories.upsert({
      githubRepositoryId: discovered.githubRepositoryId,
      owner: discovered.owner,
      name: discovered.name,
      defaultBranch: discovered.defaultBranch,
      localBasePath,
      ...profiled,
    });
    return fromStored(stored);
  }
}
