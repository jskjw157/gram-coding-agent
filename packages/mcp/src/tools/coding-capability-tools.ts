import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

const identity = { taskId: z.string().uuid(), stepId: z.string().uuid() };
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const path = z.string().min(1).max(1024).refine((value) =>
  !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') &&
  value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
  'A canonical task-relative path is required');
export const CodingGetInput = z.object({ taskId: identity.taskId }).strict();
export const CodingReadInput = z.object({ ...identity, path }).strict();
export const CodingFailInput = z.object(identity).strict();
export const CodingSubmitInput = z.discriminatedUnion('phase', [
  z.object({ ...identity, phase: z.literal('INSTRUCTIONS'), digest: hash }).strict(),
  z.object({ ...identity, phase: z.literal('ANALYZE'), summary: z.string().trim().min(1).max(8192), files: z.array(path).min(1).max(100) }).strict(),
  z.object({ ...identity, phase: z.literal('MODIFY'), patches: z.array(z.object({
    path, expectedSha256: hash.nullable(), content: z.string().max(262144),
  }).strict()).min(1).max(100) }).strict(),
]);
export type CodingSubmission = z.infer<typeof CodingSubmitInput>;
export interface CodingCapabilityPort {
  get(taskId: string): unknown;
  read(taskId: string, stepId: string, path: string): unknown;
  submit(input: CodingSubmission): unknown;
  fail(taskId: string, stepId: string): unknown;
}

export function registerCodingCapabilityTools(server: McpServer, port: CodingCapabilityPort): void {
  const response = async (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(await value) }] });
  server.registerTool('coding_step_get', {
    description: 'Get the pending coding step for a task; reconnect by reading this again.', inputSchema: CodingGetInput,
  }, ({ taskId }) => response(port.get(taskId)));
  server.registerTool('coding_step_read', {
    description: 'Read an ordinary source file through the active task-bound coding step.', inputSchema: CodingReadInput,
  }, ({ taskId, stepId, path }) => response(port.read(taskId, stepId, path)));
  server.registerTool('coding_step_submit', {
    description: 'Submit a single-use coding result bound to the pending task and step.', inputSchema: CodingSubmitInput,
  }, (input) => response(port.submit(input)));
  server.registerTool('coding_step_fail', {
    description: 'Fail the active coding step without releasing its repository lock.', inputSchema: CodingFailInput,
  }, ({ taskId, stepId }) => response(port.fail(taskId, stepId)));
}
