import { describe, expect, it, vi } from 'vitest';
import {
  VerificationTaskInput,
  createVerificationToolHandlers,
  type VerificationToolsPort,
} from './verification-tools.js';

const taskId = '018d8a73-6b4e-7000-8000-000000000001';

function ports() {
  return {
    plan: vi.fn(async () => ({ taskId, changeClass: 'FRONTEND_LOGIC' })),
    run: vi.fn(async () => ({ taskId, passed: true })),
    status: vi.fn(async () => ({ taskId, passed: true, checks: [] })),
    evidence: vi.fn(async () => ({ taskId, checks: [] })),
  } satisfies VerificationToolsPort;
}

describe('verification MCP schemas', () => {
  it('requires a task UUID and rejects unrestricted extra input', () => {
    expect(VerificationTaskInput.parse({ taskId })).toEqual({ taskId });
    expect(VerificationTaskInput.safeParse({ taskId: 'not-a-uuid' }).success).toBe(false);
    expect(
      VerificationTaskInput.safeParse({ taskId, cwd: '/tmp/unrestricted' }).success,
    ).toBe(false);
  });
});

describe('verification MCP handlers', () => {
  it('routes plan/run/status/evidence only by task identity', async () => {
    const verification = ports();
    const handlers = createVerificationToolHandlers(verification);

    const planned = await handlers.plan({ taskId });
    const ran = await handlers.run({ taskId });
    const status = await handlers.status({ taskId });
    const evidence = await handlers.evidence({ taskId });

    expect(verification.plan).toHaveBeenCalledWith(taskId);
    expect(verification.run).toHaveBeenCalledWith(taskId);
    expect(verification.status).toHaveBeenCalledWith(taskId);
    expect(verification.evidence).toHaveBeenCalledWith(taskId);

    expect(JSON.parse(planned.content[0]?.text ?? 'null')).toMatchObject({
      taskId,
      changeClass: 'FRONTEND_LOGIC',
    });
    expect(JSON.parse(ran.content[0]?.text ?? 'null')).toMatchObject({
      taskId,
      passed: true,
    });
    expect(JSON.parse(status.content[0]?.text ?? 'null')).toMatchObject({
      taskId,
      passed: true,
    });
    expect(JSON.parse(evidence.content[0]?.text ?? 'null')).toMatchObject({
      taskId,
    });
  });
});
