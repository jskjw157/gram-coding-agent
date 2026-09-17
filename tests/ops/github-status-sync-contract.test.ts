import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const statusScript = readFileSync(join(process.cwd(), 'scripts/github-status-sync.sh'), 'utf8');
const backlogScript = readFileSync(join(process.cwd(), 'scripts/github-backlog.sh'), 'utf8');

describe('evidence-driven GitHub Project status sync', () => {
  it('maps only closed M0-M1 issues to Done', () => {
    expect(statusScript).toContain("if [[ \"$state\" != 'CLOSED' ]]");
    expect(statusScript).toContain("preserve open issue");
  });

  it('does not close issues or manufacture evidence itself', () => {
    expect(statusScript).not.toContain('gh issue close');
    expect(statusScript).not.toContain('gh issue edit');
    expect(statusScript).toContain("gh issue list --repo \"$REPO\" --state all");
  });

  it('fails closed when Projects v2 access is unavailable', () => {
    expect(statusScript).toContain('GitHub token cannot access Projects v2');
    expect(statusScript).toContain("project not found: $PROJECT_TITLE");
  });
});

describe('gh project item-edit compatibility', () => {
  it.each([
    ['backlog bootstrap', backlogScript],
    ['status sync', statusScript],
  ])('%s uses the node-id machine interface', (_name, script) => {
    expect(script).toMatch(/gh project item-edit[\s\\]*--id \"\$item_id\"/);
    expect(script).toContain('--project-id "$PROJECT_ID"');
    expect(script).toContain('--field-id "$field_id"');
    expect(script).toContain('--single-select-option-id "$option_id"');
  });

  it.each([
    ['backlog bootstrap', backlogScript],
    ['status sync', statusScript],
  ])('%s does not use the legacy name/url item-edit invocation', (_name, script) => {
    const itemEditCommands = script
      .split('\n')
      .filter((line) => line.includes('gh project item-edit'))
      .join('\n');

    expect(itemEditCommands).not.toContain('--owner');
    expect(itemEditCommands).not.toContain('--url');
    expect(itemEditCommands).not.toContain('--field ');
    expect(itemEditCommands).not.toContain('--value');
  });
});
