import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RepositoryInspection } from './repo-profiler.js';

const PROFILE_FILES = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'build.gradle',
  'gradlew',
  'pom.xml',
  'pyproject.toml',
  'package.json',
] as const;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export class RepoInspector {
  async inspect(localBasePath: string): Promise<RepositoryInspection> {
    const files: string[] = [];
    for (const name of PROFILE_FILES) {
      if (await exists(join(localBasePath, name))) files.push(name);
    }

    let packageJson: RepositoryInspection['packageJson'];
    if (files.includes('package.json')) {
      const raw = await readFile(join(localBasePath, 'package.json'), 'utf8');
      packageJson = JSON.parse(raw) as RepositoryInspection['packageJson'];
    }

    return {
      files,
      ...(packageJson === undefined ? {} : { packageJson }),
    };
  }
}
