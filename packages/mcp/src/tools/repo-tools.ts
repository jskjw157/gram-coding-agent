import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

export const RepoResolveInput = z.object({ selector: z.string().trim().min(1) });
export type RepoResolveInputValue = z.infer<typeof RepoResolveInput>;

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

export interface RepoResolvePort {
  resolve(selector: string): Promise<RepoResolveView>;
}

export function registerRepoTools(server: McpServer, resolver: RepoResolvePort): void {
  server.registerTool(
    'repo_resolve',
    {
      description: 'Resolve or onboard a repository through the repository registry.',
      inputSchema: RepoResolveInput,
    },
    async ({ selector }) => {
      const profile = await resolver.resolve(selector);
      return { content: [{ type: 'text' as const, text: JSON.stringify(profile) }] };
    },
  );
}
