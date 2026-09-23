import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

const TaskId = z.string().uuid();

export const VerificationTaskInput = z
  .object({
    taskId: TaskId,
  })
  .strict();

export type VerificationTaskInputValue = z.infer<typeof VerificationTaskInput>;

type MaybePromise<T> = T | Promise<T>;

export interface VerificationToolsPort {
  plan(taskId: string): MaybePromise<unknown>;
  run(taskId: string): MaybePromise<unknown>;
  status(taskId: string): MaybePromise<unknown>;
  evidence(taskId: string): MaybePromise<unknown>;
}

function jsonResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  };
}

export function createVerificationToolHandlers(
  verification: VerificationToolsPort,
) {
  return {
    plan: async ({ taskId }: VerificationTaskInputValue) =>
      jsonResult(await verification.plan(taskId)),
    run: async ({ taskId }: VerificationTaskInputValue) =>
      jsonResult(await verification.run(taskId)),
    status: async ({ taskId }: VerificationTaskInputValue) =>
      jsonResult(await verification.status(taskId)),
    evidence: async ({ taskId }: VerificationTaskInputValue) =>
      jsonResult(await verification.evidence(taskId)),
  };
}

export function registerVerificationTools(
  server: McpServer,
  verification: VerificationToolsPort,
): void {
  const handlers = createVerificationToolHandlers(verification);

  server.registerTool(
    'verification_plan',
    {
      description: 'Create or return the verification plan for a task.',
      inputSchema: VerificationTaskInput,
    },
    handlers.plan,
  );

  server.registerTool(
    'verification_run',
    {
      description: 'Run the persisted verification plan for a task.',
      inputSchema: VerificationTaskInput,
    },
    handlers.run,
  );

  server.registerTool(
    'verification_status',
    {
      description: 'Return verification status for the selected task.',
      inputSchema: VerificationTaskInput,
    },
    handlers.status,
  );

  server.registerTool(
    'verification_evidence',
    {
      description: 'Return persisted verification evidence for the selected task.',
      inputSchema: VerificationTaskInput,
    },
    handlers.evidence,
  );
}
