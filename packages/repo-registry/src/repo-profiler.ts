import type { RepositoryCommands } from '@gram/persistence';

export interface RepositoryInspection {
  files: readonly string[];
  packageJson?: {
    scripts?: Record<string, unknown>;
  };
}

export interface RepositoryProjectProfile {
  projectType?: string;
  language?: string;
  packageManager?: string;
  commands: RepositoryCommands;
  profile: Record<string, unknown>;
}

const COMMAND_NAMES = ['lint', 'test', 'build', 'dev'] as const;

type NodePackageManager = 'pnpm' | 'npm' | 'yarn';

function declaredNodeCommands(
  packageManager: NodePackageManager,
  packageJson: RepositoryInspection['packageJson'],
): RepositoryCommands {
  const scripts = packageJson?.scripts ?? {};
  const commands: RepositoryCommands = {};
  for (const name of COMMAND_NAMES) {
    if (typeof scripts[name] !== 'string') continue;
    if (packageManager === 'pnpm') commands[name] = `pnpm ${name}`;
    else if (packageManager === 'npm') commands[name] = `npm run ${name}`;
    else commands[name] = `yarn ${name}`;
  }
  return commands;
}

export class RepositoryProfiler {
  profile(inspection: RepositoryInspection): RepositoryProjectProfile {
    const files = new Set(inspection.files);

    let packageManager: string | undefined;
    let projectType: string | undefined;
    let language: string | undefined;

    if (files.has('pnpm-lock.yaml')) {
      packageManager = 'pnpm';
      projectType = 'node';
      language = 'javascript';
    } else if (files.has('package-lock.json')) {
      packageManager = 'npm';
      projectType = 'node';
      language = 'javascript';
    } else if (files.has('yarn.lock')) {
      packageManager = 'yarn';
      projectType = 'node';
      language = 'javascript';
    } else if (files.has('build.gradle') || files.has('gradlew')) {
      packageManager = 'gradle';
      projectType = 'jvm';
      language = 'java';
    } else if (files.has('pom.xml')) {
      packageManager = 'maven';
      projectType = 'jvm';
      language = 'java';
    } else if (files.has('pyproject.toml')) {
      packageManager = 'python';
      projectType = 'python';
      language = 'python';
    }

    const commands =
      packageManager === 'pnpm' || packageManager === 'npm' || packageManager === 'yarn'
        ? declaredNodeCommands(packageManager, inspection.packageJson)
        : {};

    return {
      ...(projectType === undefined ? {} : { projectType }),
      ...(language === undefined ? {} : { language }),
      ...(packageManager === undefined ? {} : { packageManager }),
      commands,
      profile: {},
    };
  }
}
