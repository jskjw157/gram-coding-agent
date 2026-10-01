export type ChangeClass =
  | 'DOCUMENTATION'
  | 'CONFIG'
  | 'FRONTEND_LOGIC'
  | 'UI'
  | 'BACKEND'
  | 'DB_MIGRATION'
  | 'CI_WORKFLOW'
  | 'OTHER';

export interface ChangeSet {
  paths: readonly string[];
}

function normalize(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
}

function isDocumentation(path: string): boolean {
  return path.startsWith('docs/') || path.endsWith('.md') || path.endsWith('.mdx');
}

function isConfig(path: string): boolean {
  return (
    path === 'package.json' ||
    path === 'pnpm-workspace.yaml' ||
    path.startsWith('.config/') ||
    /(^|\/)(tsconfig|eslint|prettier|vite|vitest|webpack|rollup)[^/]*\.(json|js|cjs|mjs|ts)$/.test(
      path,
    ) ||
    /\.(ya?ml|toml|ini)$/.test(path)
  );
}

function isUi(path: string): boolean {
  return (
    /(^|\/)(components|pages|views|ui)\//.test(path) &&
    /\.(tsx|jsx|vue|svelte)$/.test(path)
  );
}

function isBackend(path: string): boolean {
  return (
    /(^|\/)(server|backend|controllers|handlers|routes)\//.test(path) ||
    /\.(controller|handler|route|service)\.(ts|js|java|kt|py)$/.test(path)
  );
}

function isDatabaseMigration(path: string): boolean {
  return (
    /(^|\/)(migrations?|db\/migrations?)\//.test(path) ||
    /\.(up|down)\.sql$/.test(path)
  );
}

function isCiWorkflow(path: string): boolean {
  return path.startsWith('.github/workflows/') || path.startsWith('.gitlab-ci');
}

function isSource(path: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|java|kt|py)$/.test(path);
}

export class ChangeClassifier {
  classify(changeSet: ChangeSet): ChangeClass {
    const paths = changeSet.paths.map(normalize);
    if (paths.length === 0) return 'OTHER';

    if (paths.every(isDocumentation)) return 'DOCUMENTATION';
    if (paths.some(isCiWorkflow)) return 'CI_WORKFLOW';
    if (paths.some(isDatabaseMigration)) return 'DB_MIGRATION';
    if (paths.some(isUi)) return 'UI';
    if (paths.some(isBackend)) return 'BACKEND';
    if (paths.every(isConfig)) return 'CONFIG';
    if (paths.some(isSource)) return 'FRONTEND_LOGIC';
    if (paths.some(isConfig)) return 'CONFIG';
    return 'OTHER';
  }
}
