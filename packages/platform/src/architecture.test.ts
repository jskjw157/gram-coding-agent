import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const sourceDir = fileURLToPath(new URL('.', import.meta.url));
const root = new URL('../../../', import.meta.url);

describe('platform integration boundaries', () => {
  it('keeps production code free from execution, filesystem, network and secret-provider dependencies', () => {
    const allowed = new Set(['node:process', 'node:os']);
    for (const name of readdirSync(sourceDir).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
      const text = readFileSync(new URL(name, import.meta.url), 'utf8');
      const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node): void {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          const value = node.moduleSpecifier.text;
          expect(value.startsWith('./') || allowed.has(value), `${name}: ${value}`).toBe(true);
        }
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          throw new Error(`Dynamic import not permitted in ${name}`);
        }
        ts.forEachChild(node, visit);
      }
      visit(file);
      expect(text).not.toMatch(/process\s*\.\s*env|process\s*\[\s*['"]env/);
    }
  });
  it('is collected by root tests and fails if its own test collection is empty', () => {
    const config = readFileSync(new URL('../vitest.config.ts', import.meta.url), 'utf8');
    const rootConfig = readFileSync(new URL('vitest.config.mts', root), 'utf8');
    expect(rootConfig).toContain('packages/*/vitest.config.ts');
    expect(config).toMatch(/passWithNoTests:\s*false/);
    expect(config).toContain("name: 'platform'");
  });
  it('includes a native Mac workflow and an honest diagnostic runbook', () => {
    const workflow = readFileSync(new URL('.github/workflows/macos-platform.yml', root), 'utf8');
    const runbook = readFileSync(new URL('docs/operations/macos-platform-readiness.md', root), 'utf8');
    expect(workflow).toContain('macos-15');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('pnpm --filter @gram/platform test');
    expect(workflow).not.toContain('pull_request_target');
    expect(runbook).toContain('DIAGNOSTIC_ONLY');
    expect(runbook).toContain('NOT_RUN');
  });
});
