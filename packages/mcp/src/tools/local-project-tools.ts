import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

const relativePath = z.string().min(1).max(2048);
export const LocalProjectListInput = z.object({
  path: relativePath.default('.'),
}).strict();
export const LocalProjectReadInput = z.object({
  path: relativePath,
  startLine: z.number().int().min(1).max(1000000).default(1),
  maxLines: z.number().int().min(1).max(200).default(120),
}).strict();

export interface LocalProjectEntry {
  name: string;
  type: 'file' | 'directory';
}
export interface LocalProjectListView {
  path: string;
  entries: LocalProjectEntry[];
  truncated: boolean;
}
export interface LocalProjectReadView {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
  truncated: boolean;
}
export interface LocalProjectToolsPort {
  list(path: string): LocalProjectListView | Promise<LocalProjectListView>;
  read(path: string, startLine: number, maxLines: number): LocalProjectReadView | Promise<LocalProjectReadView>;
}

function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

export function registerLocalProjectTools(server: McpServer, port: LocalProjectToolsPort): void {
  server.registerTool('local_project_list', {
    description: 'List visible source entries relative to one Agent-configured read-only project root; no arbitrary filesystem access.',
    inputSchema: LocalProjectListInput,
  }, async ({ path }) => jsonResult(await port.list(path)));

  server.registerTool('local_project_read', {
    description: 'Read bounded UTF-8 source lines relative to the configured read-only local root; no arbitrary paths or writes.',
    inputSchema: LocalProjectReadInput,
  }, async ({ path, startLine, maxLines }) => jsonResult(await port.read(path, startLine, maxLines)));
}
