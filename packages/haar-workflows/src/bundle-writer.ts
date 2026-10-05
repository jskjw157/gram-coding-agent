import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CompletionStatus, DraftBundle } from './types.js';

export interface BundleWriterOptions {
  /**
   * Accepted for instrumentation compatibility and never invoked: commits
   * are local filesystem writes only. Tests prove the port stays silent.
   */
  readonly remoteMutationPort?: { recordRemoteMutation(): void };
}

function isBundleLike(value: unknown): value is DraftBundle {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['bundleId'] === 'string' &&
    record['remoteMutationCount'] === 0 &&
    record['publication'] === 'NOT_REQUESTED' &&
    record['completion'] === 'REVIEW_READY'
  );
}

/**
 * Atomic local bundle writer. Revisions are staged durably before commit;
 * commits land via temp-file + rename. Crash orphans (`*.tmp`) are
 * recovered or cleaned by `recoverOrphans`, never auto-published:
 * completion is always REVIEW_READY.
 */
export class BundleWriter {
  private readonly revisionsDir: string;
  private readonly bundlesDir: string;
  private readonly remoteMutationPort: { recordRemoteMutation(): void } | undefined;

  constructor(dir: string, opts?: BundleWriterOptions) {
    this.revisionsDir = join(dir, 'revisions');
    this.bundlesDir = join(dir, 'bundles');
    // Held for instrumentation compatibility and never invoked.
    this.remoteMutationPort = opts?.remoteMutationPort;
    mkdirSync(this.revisionsDir, { recursive: true });
    mkdirSync(this.bundlesDir, { recursive: true });
  }

  createRevision(bundle: DraftBundle): { revisionId: string } {
    assertLocalBundle(bundle);
    const revisionId = `rev-${bundle.bundleId}`;
    writeFileSync(join(this.revisionsDir, `${revisionId}.json`), JSON.stringify(bundle), 'utf8');
    return { revisionId };
  }

  commitRevision(revisionId: string): { bundlePath: string; completion: CompletionStatus } {
    const stagedPath = join(this.revisionsDir, `${revisionId}.json`);
    let raw: string;
    try {
      raw = readFileSync(stagedPath, 'utf8');
    } catch {
      throw new Error(`revision not found or not recovered: ${revisionId}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`revision payload corrupt: ${revisionId}`);
    }
    if (!isBundleLike(parsed)) {
      throw new Error(`revision payload is not a local review bundle: ${revisionId}`);
    }
    const bundlePath = join(this.bundlesDir, `${parsed.bundleId}.json`);
    const tmpPath = `${bundlePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(parsed), 'utf8');
    renameSync(tmpPath, bundlePath);
    return { bundlePath, completion: 'REVIEW_READY' };
  }

  recoverOrphans(): { recovered: number; cleaned: number } {
    let recovered = 0;
    let cleaned = 0;
    for (const dir of [this.revisionsDir, this.bundlesDir]) {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith('.tmp')) continue;
        const tmpPath = join(dir, entry);
        const promotedPath = join(dir, entry.slice(0, -'.tmp'.length));
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(tmpPath, 'utf8')) as unknown;
        } catch {
          rmSync(tmpPath, { force: true });
          cleaned += 1;
          continue;
        }
        if (isBundleLike(parsed)) {
          renameSync(tmpPath, promotedPath);
          recovered += 1;
        } else {
          rmSync(tmpPath, { force: true });
          cleaned += 1;
        }
      }
    }
    return { recovered, cleaned };
  }
}

function assertLocalBundle(bundle: DraftBundle): void {
  if (bundle.remoteMutationCount !== 0 || bundle.publication !== 'NOT_REQUESTED') {
    throw new Error('refusing to stage a bundle that is not local-first');
  }
}
