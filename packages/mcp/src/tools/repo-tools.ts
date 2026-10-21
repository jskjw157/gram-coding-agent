import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

export const RepoSelectorInput = z
  .object({ selector: z.string().trim().min(1) })
  .strict();
export const RepoResolveInput = RepoSelectorInput;
export const RepoListInput = z.object({}).strict();

export type RepoResolveInputValue = z.infer<typeof RepoSelectorInput>;

export interface RepoResolveView {
  githubRepositoryId: number;
  owner: string;
  name: string;
  defaultBranch: string;
  localBasePath: string;
  projectType?: string;
  language?: string;
  packageManager?: string;
  commands: Partial<Record<'lint' | 'test' | 'build' | 'dev', string>>;
  profile: Record<string, unknown>;
}

type MaybePromise<T> = T | Promise<T>;

export interface RepoToolsPort {
  resolve(selector: string): Promise<RepoResolveView>;
  list(): MaybePromise<unknown>;
  get(selector: string): MaybePromise<unknown>;
  inspect(selector: string): MaybePromise<unknown>;
  register(selector: string): MaybePromise<unknown>;
}

function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

export function registerRepoTools(server: McpServer, repos: RepoToolsPort): void {
  server.registerTool(
    'repo_resolve',
    {
      description: 'Resolve or onboard a repository through the repository registry.',
      inputSchema: RepoSelectorInput,
    },
    async ({ selector }) => jsonResult(await repos.resolve(selector)),
  );
  server.registerTool(
    'repo_list',
    {
      description: 'List registered repositories.',
      inputSchema: RepoListInput,
    },
    async () => jsonResult(await repos.list()),
  );
  server.registerTool(
    'repo_get',
    {
      description: 'Return one registered repository by selector.',
      inputSchema: RepoSelectorInput,
    },
    async ({ selector }) => jsonResult(await repos.get(selector)),
  );
  server.registerTool(
    'repo_inspect',
    {
      description: 'Inspect repository metadata without mutating task workspaces.',
      inputSchema: RepoSelectorInput,
    },
    async ({ selector }) => jsonResult(await repos.inspect(selector)),
  );
  server.registerTool(
    'repo_register',
    {
      description: 'Register or refresh a repository through the application service.',
      inputSchema: RepoSelectorInput,
    },
    async ({ selector }) => jsonResult(await repos.register(selector)),
  );
}
