import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BundleWriter } from './bundle-writer.js';
import { DraftBuilder } from './draft-builder.js';
import { createMutationCounter, fixtureProductInput } from './fixture.js';

const tempDirs: string[] = [];

afterEach(() => {
  let dir: string | undefined;
  while ((dir = tempDirs.pop()) !== undefined) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'haar-bundle-'));
  tempDirs.push(dir);
  return dir;
}

function builtBundle() {
  const counter = createMutationCounter();
  const b = new DraftBuilder({ remoteMutationPort: counter });
  const input = fixtureProductInput();
  for (const key of ['source', 'assets', 'copy', 'render', 'recheck'] as const) {
    b.runStep(key, input);
  }
  const bundle = b.finalizeBundle(input);
  return { bundle, counter };
}

describe('BundleWriter atomic commit', () => {
  it('commits atomically with completion REVIEW_READY and never published', () => {
    const dir = tempDir();
    const counter = createMutationCounter();
    const writer = new BundleWriter(dir, { remoteMutationPort: counter });
    const { bundle } = builtBundle();
    const { revisionId } = writer.createRevision(bundle);
    const receipt = writer.commitRevision(revisionId);
    expect(receipt.completion).toBe('REVIEW_READY');
    expect(bundle.remoteMutationCount).toBe(0);
    expect(bundle.publication).toBe('NOT_REQUESTED');
    expect(receipt.bundlePath).toContain(bundle.bundleId);
    expect(counter.count).toBe(0);
  });
});

describe('BundleWriter crash recovery', () => {
  it('recovers an orphaned crash revision and completes the commit', () => {
    const dir = tempDir();
    const writer = new BundleWriter(dir);
    const { bundle } = builtBundle();
    // Simulate a crash: staged revision payload left behind as an orphan
    // temp file with no durable commit record.
    const revisionsDir = join(dir, 'revisions');
    mkdirSync(revisionsDir, { recursive: true });
    writeFileSync(join(revisionsDir, 'rev-crash-001.json.tmp'), JSON.stringify(bundle));
    const recovery = writer.recoverOrphans();
    expect(recovery.recovered).toBe(1);
    expect(recovery.cleaned).toBe(0);
    const receipt = writer.commitRevision('rev-crash-001');
    expect(receipt.completion).toBe('REVIEW_READY');
  });

  it('cleans corrupt orphans without blocking later commits', () => {
    const dir = tempDir();
    const writer = new BundleWriter(dir);
    const revisionsDir = join(dir, 'revisions');
    mkdirSync(revisionsDir, { recursive: true });
    writeFileSync(join(revisionsDir, 'rev-corrupt-001.json.tmp'), 'not-json{{{');
    const recovery = writer.recoverOrphans();
    expect(recovery.cleaned).toBe(1);
    const { bundle } = builtBundle();
    const { revisionId } = writer.createRevision(bundle);
    const receipt = writer.commitRevision(revisionId);
    expect(receipt.completion).toBe('REVIEW_READY');
  });
});
