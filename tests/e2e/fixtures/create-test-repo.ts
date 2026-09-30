import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const FIXED_GIT_DATE = '2026-01-01T00:00:00Z';

export interface TestRepositoryFixture {
  rootPath: string;
  remotePath: string;
  canonicalPath: string;
  initialSha: string;
  cleanup(): void;
}

function git(cwd: string, args: readonly string[], fixedCommitDate = false): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    env: fixedCommitDate
      ? {
          ...process.env,
          GIT_AUTHOR_DATE: FIXED_GIT_DATE,
          GIT_COMMITTER_DATE: FIXED_GIT_DATE,
        }
      : process.env,
  }).trim();
}

export const NODE_ONLY_VERIFICATION_COMMANDS = {
  lint: 'node --check src/counter.ts',
  test: 'node --test test/counter.test.js',
  // This fixture declares syntax checking as its build: no package install/compiler is required.
  build: 'node --check src/counter.ts',
} as const;

type FixtureCommands = Record<'lint' | 'test' | 'build', string>;

function writeFixtureFiles(canonicalPath: string, commands?: FixtureCommands): void {
  const packageJson = {
    name: 'gram-e2e-fixture',
    version: '0.0.0',
    private: true,
    type: 'module',
    scripts: commands ?? {
      lint: 'tsc --noEmit',
      test: 'node --test test/*.test.js',
      build: 'tsc',
    },
    devDependencies: {
      typescript: '^6.0.0',
    },
  };

  writeFileSync(join(canonicalPath, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
  writeFileSync(
    join(canonicalPath, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2023',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          rootDir: 'src',
          outDir: 'dist',
          declaration: false,
          sourceMap: false,
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  writeFileSync(join(canonicalPath, '.gitignore'), 'node_modules/\ndist/\n', 'utf8');

  mkdirSync(join(canonicalPath, 'src'), { recursive: true });
  writeFileSync(
    join(canonicalPath, 'src', 'counter.ts'),
    [
      'export function increment(value: number): number {',
      '  // Intentional fixture bug: the coding task must change this to value + 1.',
      '  return value;',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );

  mkdirSync(join(canonicalPath, 'test'), { recursive: true });
  writeFileSync(
    join(canonicalPath, 'test', 'counter.test.js'),
    [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      "import { increment } from '../src/counter.ts';",
      '',
      "test('increment adds one', () => {",
      '  assert.equal(increment(1), 2);',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
}

export function createTestRepository(commands?: FixtureCommands): TestRepositoryFixture {
  const rootPath = mkdtempSync(join(tmpdir(), 'gram-e2e-repo-'));
  const remotePath = join(rootPath, 'remote.git');
  const canonicalPath = join(rootPath, 'workspace', 'github', 'acme', 'gram-e2e-fixture');

  try {
    mkdirSync(dirname(canonicalPath), { recursive: true });

    execFileSync('git', ['init', '--bare', remotePath], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    execFileSync('git', ['init', canonicalPath], {
      encoding: 'utf8',
      stdio: 'pipe',
    });

    git(canonicalPath, ['config', 'user.name', 'Gram E2E']);
    git(canonicalPath, ['config', 'user.email', 'gram-e2e@example.test']);
    writeFixtureFiles(canonicalPath, commands);

    git(canonicalPath, ['add', '.']);
    git(canonicalPath, ['commit', '-m', 'test: seed failing counter fixture'], true);
    git(canonicalPath, ['branch', '-M', 'main']);
    git(canonicalPath, ['remote', 'add', 'origin', remotePath]);
    git(canonicalPath, ['push', '-u', 'origin', 'main']);
    git(remotePath, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    git(canonicalPath, ['fetch', 'origin']);

    const initialSha = git(canonicalPath, ['rev-parse', 'HEAD']);

    return {
      rootPath,
      remotePath,
      canonicalPath,
      initialSha,
      cleanup() {
        rmSync(rootPath, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(rootPath, { recursive: true, force: true });
    throw error;
  }
}
