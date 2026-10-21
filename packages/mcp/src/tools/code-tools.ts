import { isAbsolute } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

const TaskId = z.string().uuid();
const RelativePath = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !isAbsolute(value) && !value.includes('\0'), {
    message: 'relativePath must be a relative path',
  });

export const CodeSearchInput = z.object({
  taskId: TaskId,
  pattern: z.string().min(1),
  relativePath: RelativePath.default('.'),
});
export const FileReadInput = z.object({
  taskId: TaskId,
  relativePath: RelativePath,
});
export const FileWriteInput = z.object({
  taskId: TaskId,
  relativePath: RelativePath,
  content: z.string(),
});
export const FilePatchInput = z.object({
  taskId: TaskId,
  relativePath: RelativePath,
  expectedOld: z.string().min(1),
  replacement: z.string(),
});
export const FileDiffInput = z.object({
  taskId: TaskId,
  relativePath: RelativePath,
});

export type CodeSearchInputValue = z.infer<typeof CodeSearchInput>;
export type FileReadInputValue = z.infer<typeof FileReadInput>;
export type FileWriteInputValue = z.infer<typeof FileWriteInput>;
export type FilePatchInputValue = z.infer<typeof FilePatchInput>;
export type FileDiffInputValue = z.infer<typeof FileDiffInput>;

export interface CodeSearchView {
  path: string;
  line: number;
  column: number;
  text: string;
}

type MaybePromise<T> = T | Promise<T>;

export interface CodeToolsPort {
  search(input: CodeSearchInputValue): MaybePromise<CodeSearchView[]>;
  readText(taskId: string, relativePath: string): MaybePromise<string>;
  writeText(taskId: string, relativePath: string, content: string): MaybePromise<void>;
  patchExact(
    taskId: string,
    relativePath: string,
    expectedOld: string,
    replacement: string,
  ): MaybePromise<void>;
  diff(taskId: string, relativePath: string): MaybePromise<string>;
}

export function createCodeToolHandlers(code: CodeToolsPort) {
  return {
    search: async (input: CodeSearchInputValue) => {
      const matches = await code.search(input);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(matches) }],
      };
    },
    read: async (input: FileReadInputValue) => {
      const content = await code.readText(input.taskId, input.relativePath);
      return { content: [{ type: 'text' as const, text: content }] };
    },
    write: async (input: FileWriteInputValue) => {
      await code.writeText(input.taskId, input.relativePath, input.content);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ written: true }) }],
      };
    },
    patch: async (input: FilePatchInputValue) => {
      await code.patchExact(
        input.taskId,
        input.relativePath,
        input.expectedOld,
        input.replacement,
      );
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ patched: true }) }],
      };
    },
    diff: async (input: FileDiffInputValue) => {
      const diff = await code.diff(input.taskId, input.relativePath);
      return { content: [{ type: 'text' as const, text: diff }] };
    },
  };
}

export function registerCodeTools(server: McpServer, code: CodeToolsPort): void {
  const handlers = createCodeToolHandlers(code);

  server.registerTool(
    'code_search',
    {
      description: 'Search code inside a task workspace.',
      inputSchema: CodeSearchInput,
    },
    handlers.search,
  );
  server.registerTool(
    'file_read',
    {
      description: 'Read a task-workspace-relative text file.',
      inputSchema: FileReadInput,
    },
    handlers.read,
  );
  server.registerTool(
    'file_write',
    {
      description: 'Write a task-workspace-relative text file.',
      inputSchema: FileWriteInput,
    },
    handlers.write,
  );
  server.registerTool(
    'file_patch',
    {
      description: 'Replace one exact expected hunk inside a task workspace file.',
      inputSchema: FilePatchInput,
    },
    handlers.patch,
  );
  server.registerTool(
    'file_diff',
    {
      description: 'Return the Git diff for one task-workspace-relative path.',
      inputSchema: FileDiffInput,
    },
    handlers.diff,
  );
}
