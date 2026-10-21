import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { safeJsonResult } from './read-sanitizer.js';

const relativePath = z.string().min(1).max(2048).refine(value => value === '.' ||
  (!/[\\:]/u.test(value) && !Array.from(value).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) && value.split('/').every(part =>
    part.length > 0 && part !== '.' && part !== '..' && part.toLowerCase() !== '.git' && !part.startsWith('-'))));
export const LocalRepositoryInput = z.object({ root: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u), path: relativePath }).strict();
export const LocalGitDiffInput = LocalRepositoryInput.extend({ staged: z.boolean().default(false), relativePath: relativePath.optional() }).strict();
export const LocalGitLogInput = LocalRepositoryInput.extend({ maxCount: z.number().int().min(1).max(100).default(20) }).strict();
export const LocalDeveloperRunInput = z.object({ repositoryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  command: z.enum(['lint', 'test', 'build', 'dev']), timeoutMs: z.number().int().min(1000).max(900000).default(60000) }).strict();
export type LocalRepositoryInputValue = z.infer<typeof LocalRepositoryInput>;
export type LocalGitDiffInputValue = z.infer<typeof LocalGitDiffInput>;
export type LocalGitLogInputValue = z.infer<typeof LocalGitLogInput>;
export type LocalDeveloperRunInputValue = z.infer<typeof LocalDeveloperRunInput>;
export interface LocalGitStatusView { entries: { path: string; status: string }[]; truncated: boolean }
export interface LocalGitDiffView { diff: string; truncated: boolean }
export interface LocalGitLogView { commits: { sha: string; subject: string }[]; truncated: boolean }
export interface LocalDeveloperRunView { taskId: string; commandRunId: number; status: 'SUCCEEDED' | 'FAILED'; exitCode: number;
  stdout: string; stderr: string; truncated: boolean }
export interface LocalDeveloperToolsPort {
  register(input: LocalRepositoryInputValue): Promise<{ repositoryId: number }>;
  status(input: LocalRepositoryInputValue): Promise<LocalGitStatusView>;
  diff(input: LocalGitDiffInputValue): Promise<LocalGitDiffView>;
  log(input: LocalGitLogInputValue): Promise<LocalGitLogView>;
  run(input: LocalDeveloperRunInputValue): Promise<LocalDeveloperRunView>;
}
async function call(operation: () => Promise<unknown>) {
  try { return safeJsonResult(await operation()); }
  catch { throw new Error('Local developer operation denied or failed'); }
}
export function registerLocalDeveloperTools(server: McpServer, port: LocalDeveloperToolsPort): void {
  server.registerTool('local_repo_register', { description: 'Register an existing authorized local GitHub repository using inspected metadata.', inputSchema: LocalRepositoryInput }, input => call(() => port.register(input)));
  server.registerTool('local_git_status', { description: 'Read bounded Git status for an authorized existing local project.', inputSchema: LocalRepositoryInput }, input => call(() => port.status(input)));
  server.registerTool('local_git_diff', { description: 'Read a bounded local project diff without external diff tools or text conversion.', inputSchema: LocalGitDiffInput }, input => call(() => port.diff(input)));
  server.registerTool('local_git_log', { description: 'Read bounded local project commit history.', inputSchema: LocalGitLogInput }, input => call(() => port.log(input)));
  server.registerTool('local_dev_run', { description: 'Run one declared developer command in a leased isolated task workspace with a deadline; returns command evidence, not publication or verification completion.', inputSchema: LocalDeveloperRunInput }, input => call(() => port.run(input)));
}
