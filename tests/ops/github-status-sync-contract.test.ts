import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = readFileSync(join(process.cwd(), 'scripts/github-status-sync.sh'), 'utf8');

describe('evidence-driven GitHub Project status sync', () => {
  it('maps only closed M0-M1 issues to Done', () => {
    expect(script).toContain("if [[ \"$state\" != 'CLOSED' ]]");
    expect(script).toContain("--field 'Status' --value 'Done'");
    expect(script).toContain("preserve open issue");
  });

  it('does not close issues or manufacture evidence itself', () => {
    expect(script).not.toContain('gh issue close');
    expect(script).not.toContain('gh issue edit');
    expect(script).toContain("gh issue list --repo \"$REPO\" --state all");
  });

  it('fails closed when Projects v2 access is unavailable', () => {
    expect(script).toContain('GitHub token cannot access Projects v2');
    expect(script).toContain("project not found: $PROJECT_TITLE");
  });
});
