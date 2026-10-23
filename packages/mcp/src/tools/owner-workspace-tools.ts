import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { safeJsonResult } from './read-sanitizer.js';

const root = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u);
const path = z.string().min(1).max(2048).refine(value => value === '.' ||
  (!/[\\:<>"|?*]/u.test(value) && !Array.from(value).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
    value.split('/').every(p => p.length > 0 && p !== '.' && p !== '..' && !p.endsWith('.') && !p.endsWith(' '))));
const version = z.string().regex(/^[a-f0-9]{64}$/u);
const id = z.string().uuid();
const target = z.object({ root, path }).strict();
const request = { requestId: id.optional() };
const versioned = target.extend({ expectedVersion: version }).strict();
const write = target.extend({ expectedVersion: version.nullable(), content: z.string().max(262144), ...request }).strict();
const move = versioned.extend({ destination: path, ...request }).strict();
export const OwnerWorkspaceInputs = {
  roots: z.object({}).strict(),
  list: target.extend({ offset: z.number().int().min(0).max(10000).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
  stat: target,
  read: target.extend({ startLine: z.number().int().min(1).max(1048577).optional(), maxLines: z.number().int().min(1).max(200).optional() }).strict(),
  search: target.extend({ term: z.string().min(1).max(1024), maxDepth: z.number().int().min(0).max(60).optional(),
    maxResults: z.number().int().min(1).max(100).optional(), mode: z.enum(['text', 'name']).optional(), cursor: id.optional() }).strict(),
  write,
  patch: versioned.extend({ find: z.string().min(1).max(131072), replacement: z.string().max(262144), ...request }).strict(),
  mkdir: target.extend(request).strict(),
  move,
  copy: move,
  trash: versioned.extend(request).strict(),
  restore: target.extend({ recoveryId: id, expectedVersion: version.nullable(), ...request }).strict(),
  readBinary: versioned,
  writeBinary: target.extend({ expectedVersion: version.nullable(), base64: z.string().max(349528), ...request }).strict(),
  reveal: versioned,
  convertPath: z.object({ root, path, format: z.enum(['windows', 'wsl']) }).strict(),
};
export type OwnerWorkspaceToolsPort = {
  [K in keyof typeof OwnerWorkspaceInputs]: K extends 'roots' ? () => unknown | Promise<unknown>
    : (input: z.infer<(typeof OwnerWorkspaceInputs)[K]>) => unknown | Promise<unknown>;
};
const descriptions: Record<keyof typeof OwnerWorkspaceInputs, string> = {
  roots: 'Discover all owner-configured drive/directory roots. Agent private state and unsafe OS locations remain protected.',
  list: 'List bounded entries including hidden and configuration files, with explicit pagination.',
  stat: 'Inspect bounded file metadata and opaque content version. Secret or binary bytes never receive a public hash.',
  read: 'Read bounded UTF-8 lines with whole-document credential screening before pagination; filenames are not blanket banned.',
  search: 'Incremental literal text/name search with opaque single-use continuation; results are screened.',
  write: 'Create or replace text with opaque expectedVersion, atomic native preconditions and encrypted recovery backup. Credential changes require native owner presence or trusted local standing authorization.',
  patch: 'Replace one exact unique text occurrence with expectedVersion and encrypted backup; sensitive changes require native owner presence or trusted local standing authorization.',
  mkdir: 'Create one directory under an authorized writable root. Parent must exist.',
  move: 'Move a version-bound file or bounded directory within one authorized root without overwriting the destination.',
  copy: 'Copy an approved bounded file snapshot to a new destination; credentials require native owner presence or trusted local standing authorization.',
  trash: 'Recoverably move a version-bound file or bounded directory into a protected same-volume vault. Never permanently deletes.',
  restore: 'Restore an exact private recovery record, respecting destination version or absence and owner consent for credential content.',
  readBinary: 'Export an exact bounded binary snapshot using fresh native owner approval or trusted local standing authorization. Reports authorization source. May disclose private contents to ChatGPT.',
  writeBinary: 'Create or replace canonical base64 bytes with expectedVersion and encrypted backup; opaque/sensitive contents require native owner approval or trusted local standing authorization.',
  reveal: 'Show exact credential-bearing UTF-8 snapshot in a protected local Windows viewer after native owner authentication. Raw text is never returned through MCP.',
  convertPath: 'Convert one validated authorized relative path to its configured Windows or WSL representation. Does not change access authority.',
};
const names: Record<keyof typeof OwnerWorkspaceInputs, string> = {
  roots: 'local_fs_roots', list: 'local_fs_list', stat: 'local_fs_stat', read: 'local_fs_read', search: 'local_fs_search',
  write: 'local_fs_write', patch: 'local_fs_patch', mkdir: 'local_fs_mkdir', move: 'local_fs_move', copy: 'local_fs_copy',
  trash: 'local_fs_trash', restore: 'local_fs_restore', readBinary: 'local_fs_read_binary', writeBinary: 'local_fs_write_binary',
  reveal: 'local_fs_reveal', convertPath: 'local_fs_convert_path',
};
async function call(operation: () => unknown | Promise<unknown>) {
  try { return safeJsonResult(await operation()); }
  catch { throw new Error('Owner workspace operation denied or failed'); }
}
export function registerOwnerWorkspaceTools(server: McpServer, port: OwnerWorkspaceToolsPort): void {
  server.registerTool(names.roots, { description: descriptions.roots, inputSchema: OwnerWorkspaceInputs.roots }, async () => call(() => port.roots()));
  server.registerTool(names.list, { description: descriptions.list, inputSchema: OwnerWorkspaceInputs.list }, async input => call(() => port.list(input)));
  server.registerTool(names.stat, { description: descriptions.stat, inputSchema: OwnerWorkspaceInputs.stat }, async input => call(() => port.stat(input)));
  server.registerTool(names.read, { description: descriptions.read, inputSchema: OwnerWorkspaceInputs.read }, async input => call(() => port.read(input)));
  // Separate neutral-shape response for connectors which reserve or consume
  // an inner "content" key. Preserve the original read API for older clients.
  // Only screened ordinary text can reach this endpoint; native owner-reveal
  // remains a separate, local-only explicit consent operation.
  server.registerTool('local_fs_read_lines', {
    description: 'Read screened UTF-8 source lines as a bounded lines array; equivalent authority to local_fs_read.',
    inputSchema: OwnerWorkspaceInputs.read,
  }, async input => call(async () => {
    const result = await port.read(input);
    if (!result || typeof result !== 'object' || Array.isArray(result) ||
        !('content' in result) || typeof result.content !== 'string') {
      throw new Error('Invalid screened read result');
    }
    const { content, ...metadata } = result;
    return { ...metadata, lines: content.split('\n') };
  }));
  server.registerTool(names.search, { description: descriptions.search, inputSchema: OwnerWorkspaceInputs.search }, async input => call(() => port.search(input)));
  server.registerTool(names.write, { description: descriptions.write, inputSchema: OwnerWorkspaceInputs.write }, async input => call(() => port.write(input)));
  server.registerTool(names.patch, { description: descriptions.patch, inputSchema: OwnerWorkspaceInputs.patch }, async input => call(() => port.patch(input)));
  server.registerTool(names.mkdir, { description: descriptions.mkdir, inputSchema: OwnerWorkspaceInputs.mkdir }, async input => call(() => port.mkdir(input)));
  server.registerTool(names.move, { description: descriptions.move, inputSchema: OwnerWorkspaceInputs.move }, async input => call(() => port.move(input)));
  server.registerTool(names.copy, { description: descriptions.copy, inputSchema: OwnerWorkspaceInputs.copy }, async input => call(() => port.copy(input)));
  server.registerTool(names.trash, { description: descriptions.trash, inputSchema: OwnerWorkspaceInputs.trash }, async input => call(() => port.trash(input)));
  server.registerTool(names.restore, { description: descriptions.restore, inputSchema: OwnerWorkspaceInputs.restore }, async input => call(() => port.restore(input)));
  server.registerTool(names.readBinary, { description: descriptions.readBinary, inputSchema: OwnerWorkspaceInputs.readBinary }, async input => call(() => port.readBinary(input)));
  server.registerTool(names.writeBinary, { description: descriptions.writeBinary, inputSchema: OwnerWorkspaceInputs.writeBinary }, async input => call(() => port.writeBinary(input)));
  server.registerTool(names.reveal, { description: descriptions.reveal, inputSchema: OwnerWorkspaceInputs.reveal }, async input => call(() => port.reveal(input)));
  server.registerTool(names.convertPath, { description: descriptions.convertPath, inputSchema: OwnerWorkspaceInputs.convertPath }, async input => call(() => port.convertPath(input)));
}
