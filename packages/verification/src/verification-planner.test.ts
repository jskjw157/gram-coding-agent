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
        .filter((check) => check.kind === 'COMMAND' && check.required)
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

  it('always plans secret scan and diff review as required publish gates', () => {
    const plan = planner.plan({ paths: ['docs/operations/runbook.md'] }, { commands: {}, capabilities: {} });

    expect(plan.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'secret-scan',
          kind: 'NON_COMMAND',
          required: true,
          status: 'PENDING',
        }),
        expect.objectContaining({
          name: 'diff-review',
          kind: 'NON_COMMAND',
          required: true,
          status: 'PENDING',
        }),
      ]),
    );
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

describe('VerificationPlanner.planProduction', () => {
  const planner = new VerificationPlanner();
  const commands = {
    lint: 'pnpm lint',
    test: 'pnpm test',
    build: 'pnpm build',
  };

  it('refuses an empty change set', () => {
    expect(() => planner.planProduction({ paths: [] }, { commands })).toThrow(/changed paths/i);
  });

  it.each(['lint', 'test', 'build'] as const)(
    'refuses a missing required %s command rather than omitting it',
    (name) => {
      const incompleteCommands = Object.fromEntries(
        Object.entries(commands).filter(([commandName]) => commandName !== name),
      );

      expect(() => planner.planProduction({ paths: ['src/client.ts'] }, { commands: incompleteCommands })).toThrow(
        new RegExp(`declared.*${name}.*command`, 'i'),
      );
    },
  );

  it.each(['', '  \t\n', null, 123, true])('refuses an invalid required command: %j', (command) => {
    expect(() =>
      planner.planProduction({ paths: ['docs/runbook.md'] }, { commands: { lint: command as string } }),
    ).toThrow(/declared.*lint.*command/i);
  });

  it('requires only the declared lint command for documentation-only changes', () => {
    const plan = planner.planProduction(
      { paths: ['README.md', 'docs/runbook.md'] },
      { commands: { lint: 'npm run docs:lint' } },
    );

    expect(plan.changeClass).toBe('DOCUMENTATION');
    expect(plan.checks).toEqual([
      {
        name: 'lint',
        kind: 'COMMAND',
        required: true,
        status: 'PENDING',
        command: 'npm run docs:lint',
      },
      {
        name: 'secret-scan',
        kind: 'NON_COMMAND',
        required: true,
        status: 'PENDING',
      },
      {
        name: 'diff-review',
        kind: 'NON_COMMAND',
        required: true,
        status: 'PENDING',
      },
    ]);
  });

  it('does not require lint for backend-only changes', () => {
    const plan = planner.planProduction(
      { paths: ['src/server/api.ts'] },
      { commands: { test: 'npm test', build: 'npm run build' } },
    );

    expect(plan.checks.filter((check) => check.kind === 'COMMAND')).toEqual([
      expect.objectContaining({ name: 'test', command: 'npm test' }),
      expect.objectContaining({ name: 'build', command: 'npm run build' }),
    ]);
  });

  it.each([
    ['backend and documentation', ['src/server/api.ts', 'README.md']],
    ['CI and backend', ['.github/workflows/check.yml', 'src/server/api.ts']],
    ['migration and config', ['db/migrations/001.sql', 'package.json']],
    ['CI and unknown', ['.github/workflows/check.yml', 'assets/data.bin']],
    ['migration and frontend logic', ['db/migrations/001.sql', 'src/client.ts']],
  ] as const)('unions all required commands for %s', (_name, paths) => {
    const plan = planner.planProduction({ paths }, { commands });

    expect(
      plan.checks
        .filter((check) => check.kind === 'COMMAND')
        .map((check) => [check.name, check.command, check.required, check.status]),
    ).toEqual([
      ['lint', 'pnpm lint', true, 'PENDING'],
      ['test', 'pnpm test', true, 'PENDING'],
      ['build', 'pnpm build', true, 'PENDING'],
    ]);
  });

  it('deduplicates checks and keeps their order independent of path order', () => {
    const paths = ['src/server/api.ts', 'README.md', 'package.json', 'docs/guide.md'];
    const forward = planner.planProduction({ paths }, { commands });
    const reverse = planner.planProduction({ paths: [...paths].reverse() }, { commands });

    expect(forward.checks).toEqual(reverse.checks);
    expect(forward.checks.map((check) => check.name)).toEqual(['lint', 'test', 'build', 'secret-scan', 'diff-review']);
  });

  it('requires documentation lint even when backend is the aggregate change class', () => {
    expect(() =>
      planner.planProduction(
        { paths: ['src/server/api.ts', 'README.md'] },
        { commands: { test: commands.test, build: commands.build } },
      ),
    ).toThrow(/declared.*lint.*command/i);
  });

  it.each([
    'src/App.tsx',
    'src/App.jsx',
    'src/App.vue',
    'src/App.svelte',
    'src/page.astro',
    'docs/components.mdx',
    'src/styles.css',
    'src/styles.scss',
    'src/styles.sass',
    'src/styles.less',
    'public/index.html',
    'assets/icon.svg',
    'docs/demo.tsx',
    '.\\src\\styles.CSS',
  ])('refuses UI path %s without a wired browser evidence provider', (path) => {
    expect(() => planner.planProduction({ paths: [path] }, { commands })).toThrow(/UI.*browser evidence provider/i);
  });

  it.each([undefined, false, true])(
    'refuses mixed CI and UI regardless of declared browser capability: %s',
    (browserVerification) => {
      expect(() =>
        planner.planProduction(
          { paths: ['.github/workflows/check.yml', 'src/components/Button.tsx'] },
          {
            commands,
            capabilities: browserVerification === undefined ? {} : { browserVerification },
          },
        ),
      ).toThrow(/UI.*browser evidence provider/i);
    },
  );

  it('reports the absent browser evidence provider before validating UI commands', () => {
    expect(() =>
      planner.planProduction(
        { paths: ['src/styles.css'] },
        { commands: {}, capabilities: { browserVerification: true } },
      ),
    ).toThrow(/UI.*browser evidence provider/i);
  });
});
