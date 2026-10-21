import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { safeJsonResult } from './read-sanitizer.js';

const root = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u);
const path = z.string().min(1).max(2048);
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const bounds = z.object({
  root, path,
}).strict();

export const LocalFsListInput = bounds.extend({
  offset: z.number().int().nonnegative().max(100000).default(0),
  limit: z.number().int().min(1).max(100).default(100),
}).strict();
export const LocalFsReadInput = bounds.extend({
  startLine: z.number().int().min(1).max(1000000).default(1),
  maxLines: z.number().int().min(1).max(200).default(100),
}).strict();
export const LocalFsSearchInput = bounds.extend({
  term: z.string().min(1).max(256),
  maxResults: z.number().int().min(1).max(100).default(30),
  maxDepth: z.number().int().min(0).max(6).default(3),
}).strict();
export const LocalFsWriteInput = bounds.extend({
  expectedSha256: sha.nullable(),
  content: z.string().max(262144),
}).strict();
export const LocalFsPatchInput = bounds.extend({
  expectedSha256: sha,
  find: z.string().min(1).max(131072),
  replacement: z.string().max(262144),
}).strict();
export const LocalFsMoveInput = bounds.extend({
  destination: path,
  expectedSha256: sha,
}).strict();
export const LocalFsCopyInput = LocalFsMoveInput;
export const LocalFsTrashInput = bounds.extend({
  expectedSha256: sha,
}).strict();
export const LocalFsRootsInput = z.object({}).strict();

type MaybePromise<T> = T | Promise<T>;

// System errors can contain absolute /proc or Windows host paths. Never
// surface native exception text through the remote MCP transport.
async function safeCall(operation: () => MaybePromise<unknown>) {
  try { return safeJsonResult(await operation()); }
  catch { throw new Error('Local filesystem operation denied or failed'); }
}
export interface LocalFsToolsPort {
  roots(): MaybePromise<unknown>;
  list(input: z.infer<typeof LocalFsListInput>): MaybePromise<unknown>;
  stat(input: z.infer<typeof bounds>): MaybePromise<unknown>;
  read(input: z.infer<typeof LocalFsReadInput>): MaybePromise<unknown>;
  search(input: z.infer<typeof LocalFsSearchInput>): MaybePromise<unknown>;
  write(input: z.infer<typeof LocalFsWriteInput>): MaybePromise<unknown>;
  patch(input: z.infer<typeof LocalFsPatchInput>): MaybePromise<unknown>;
  mkdir(input: z.infer<typeof bounds>): MaybePromise<unknown>;
  move(input: z.infer<typeof LocalFsMoveInput>): MaybePromise<unknown>;
  copy(input: z.infer<typeof LocalFsCopyInput>): MaybePromise<unknown>;
  trash(input: z.infer<typeof LocalFsTrashInput>): MaybePromise<unknown>;
}

export function registerLocalFsTools(server: McpServer, port: LocalFsToolsPort): void {
  server.registerTool('local_fs_roots', {
    description: 'Discover owner-configured Windows/WSL filesystem roots and their available capabilities.',
    inputSchema: LocalFsRootsInput,
  }, async () => safeCall(() => port.roots()));
  server.registerTool('local_fs_list', {
    description: 'List entries including hidden/config files under an authorized Windows/WSL filesystem root.',
    inputSchema: LocalFsListInput,
  }, async (input) => safeCall(() => port.list(input)));
  server.registerTool('local_fs_stat', {
    description: 'Stat and hash one authorized local filesystem path without reading content.',
    inputSchema: bounds,
  }, async (input) => safeCall(() => port.stat(input)));
  server.registerTool('local_fs_read', {
    description: 'Read any UTF-8 text/config file under an authorized local root with sensitive values masked by default.',
    inputSchema: LocalFsReadInput,
  }, async (input) => safeCall(() => port.read(input)));
  server.registerTool('local_fs_search', {
    description: 'Perform bounded literal-text search through authorized local directory trees; sensitive matches are masked.',
    inputSchema: LocalFsSearchInput,
  }, async (input) => safeCall(() => port.search(input)));
  server.registerTool('local_fs_write', {
    description: 'Create or atomically replace a text file using an exact expected SHA256; retain a private backup.',
    inputSchema: LocalFsWriteInput,
  }, async (input) => safeCall(() => port.write(input)));
  server.registerTool('local_fs_patch', {
    description: 'Apply one exact text replacement guarded by expected SHA256 and private recovery backup.',
    inputSchema: LocalFsPatchInput,
  }, async (input) => safeCall(() => port.patch(input)));
  server.registerTool('local_fs_mkdir', {
    description: 'Create one local directory under an authorized writable root; parent must exist.',
    inputSchema: bounds,
  }, async (input) => safeCall(() => port.mkdir(input)));
  server.registerTool('local_fs_move', {
    description: 'Rename a SHA-bound local file safely within the same authorized filesystem root.',
    inputSchema: LocalFsMoveInput,
  }, async (input) => safeCall(() => port.move(input)));
  server.registerTool('local_fs_copy', {
    description: 'Copy a SHA-bound local file only to a destination that does not already exist.',
    inputSchema: LocalFsCopyInput,
  }, async (input) => safeCall(() => port.copy(input)));
  server.registerTool('local_fs_trash', {
    description: 'Move a SHA-bound file to recoverable private storage rather than deleting it.',
    inputSchema: LocalFsTrashInput,
  }, async (input) => safeCall(() => port.trash(input)));
}
