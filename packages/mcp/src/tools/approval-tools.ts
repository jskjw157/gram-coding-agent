import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { safeJsonResult } from './read-sanitizer.js';

const TaskId = z.string().uuid();

// Mirrors the producer in packages/policy/src/policy-engine.ts: the hash is a
// sha256 digest rendered with .digest('hex'), i.e. 64 lowercase hex chars.
// Kept as a local refinement on purpose: this tool layer must not import
// across package boundaries (no persistence / policy / apps imports).
const OperationHash = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'operationHash must be 64 lowercase hex chars');

export const ApprovalListInput = z
  .object({
    taskId: TaskId,
  })
  .strict();

export const ApprovalDecisionInput = z
  .object({
    approvalId: z.string(),
    operationHash: OperationHash,
  })
  .strict();

export type ApprovalListInputValue = z.infer<typeof ApprovalListInput>;
export type ApprovalDecisionInputValue = z.infer<
  typeof ApprovalDecisionInput
>;

type MaybePromise<T> = T | Promise<T>;

export interface ApprovalToolsPort {
  list(taskId: string): MaybePromise<unknown>;
  approve(approvalId: string, operationHash: string): MaybePromise<unknown>;
  deny(approvalId: string, operationHash: string): MaybePromise<unknown>;
}

function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

export function createApprovalListHandler(port: ApprovalToolsPort) {
  return async (input: ApprovalListInputValue) =>
    safeJsonResult(await port.list(input.taskId));
}

export function createApprovalApproveHandler(port: ApprovalToolsPort) {
  return async (input: ApprovalDecisionInputValue) =>
    jsonResult(await port.approve(input.approvalId, input.operationHash));
}

export function createApprovalDenyHandler(port: ApprovalToolsPort) {
  return async (input: ApprovalDecisionInputValue) =>
    jsonResult(await port.deny(input.approvalId, input.operationHash));
}

export function registerApprovalTools(
  server: McpServer,
  port: ApprovalToolsPort,
): void {
  server.registerTool(
    'approval_list',
    {
      description: 'List approval requests for the selected task.',
      inputSchema: ApprovalListInput,
    },
    createApprovalListHandler(port),
  );
  server.registerTool(
    'approval_approve',
    {
      description: 'Approve a pending approval request by asserting its expected operation hash.',
      inputSchema: ApprovalDecisionInput,
    },
    createApprovalApproveHandler(port),
  );
  server.registerTool(
    'approval_deny',
    {
      description: 'Deny a pending approval request by asserting its expected operation hash.',
      inputSchema: ApprovalDecisionInput,
    },
    createApprovalDenyHandler(port),
  );
}
