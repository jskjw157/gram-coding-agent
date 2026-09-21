import { describe, expect, it } from 'vitest';
import { VerificationPlanner } from './verification-planner.js';

describe('VerificationPlanner', () => {
  const planner = new VerificationPlanner();

  it('requires lint, test, and build for frontend logic when the repository declares them', () => {
    const plan = planner.plan(
      { paths: ['src/api/client.ts'] },
      {
        commands: {
          lint: 'pnpm lint',
          test: 'pnpm test',
          build: 'pnpm build',
        },
        capabilities: {},
      },
    );

    expect(plan.changeClass).toBe('FRONTEND_LOGIC');
    expect(
      plan.checks
        .filter((check) => check.required)
        .map((check) => [check.name, check.command]),
    ).toEqual([
      ['lint', 'pnpm lint'],
      ['test', 'pnpm test'],
      ['build', 'pnpm build'],
    ]);
  });

  it('does not invent build or test checks for documentation-only changes', () => {
    const plan = planner.plan(
      { paths: ['docs/operations/runbook.md'] },
      {
        commands: {
          lint: 'pnpm lint',
        },
        capabilities: {},
      },
    );

    expect(plan.changeClass).toBe('DOCUMENTATION');
    expect(plan.checks.some((check) => check.name === 'build')).toBe(false);
    expect(plan.checks.some((check) => check.name === 'test')).toBe(false);
  });

  it('requires browser verification for UI changes only when the repository declares the capability', () => {
    const capable = planner.plan(
      { paths: ['src/components/Button.tsx'] },
      {
        commands: {
          lint: 'pnpm lint',
          test: 'pnpm test',
          build: 'pnpm build',
        },
        capabilities: { browserVerification: true },
      },
    );
    const browser = capable.checks.find((check) => check.name === 'browser');
    expect(browser).toMatchObject({
      required: true,
      status: 'PENDING',
    });

    const incapable = planner.plan(
      { paths: ['src/components/Button.tsx'] },
      {
        commands: {
          lint: 'pnpm lint',
          test: 'pnpm test',
          build: 'pnpm build',
        },
        capabilities: {},
      },
    );
    expect(incapable.checks.find((check) => check.name === 'browser')).toMatchObject({
      required: false,
      status: 'SKIPPED',
      reason: 'Repository profile does not declare browser verification capability',
    });
  });
});
