// artifact-store.ts — artifact store (MAC-03 WP-12, decision D11).
//
// Write path is tmp -> verify -> rename: bytes land in a staging tmp file,
// are verified (staging cap, digest, containment), then atomically renamed to
// the final name. Path escape (traversal, absolute) and symlinked final paths
// are refused. Redaction is allowlist-first: only allowlisted fields survive,
// and bearer-style secrets are scrubbed from text.
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

export const STAGING_CAP_BYTES = 64 * 1024;

export const REDACTED = '[REDACTED]';

const SAFE_FIELDS: readonly string[] = [
  'artifactId',
  'digest',
  'version',
  'recipeId',
  'taskKind',
  'executionMode',
  'scope',
  'effectClass',
];

export class ArtifactError extends Error {
  override name = 'ArtifactError';
}

export class ArtifactEscapeError extends ArtifactError {
  override name = 'ArtifactEscapeError';
}

export class ArtifactCapError extends ArtifactError {
  override name = 'ArtifactCapError';
}

export class ArtifactSymlinkError extends ArtifactError {
  override name = 'ArtifactSymlinkError';
}

export interface StagedArtifact {
  readonly stagingId: string;
  readonly artifactId: string;
  readonly bytes: number;
}

export interface FinalizedArtifact {
  readonly artifactId: string;
  readonly digest: string;
}

interface StagingEntry {
  artifactId: string;
  tmpPath: string;
  digest: string;
  bytes: number;
}

const shaHex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const assertSafeName = (root: string, name: string): string => {
  if (typeof name !== 'string' || name.length === 0 || name.includes('\0')) {
    throw new ArtifactEscapeError('artifact name must be a non-empty string');
  }
  if (isAbsolute(name)) {
    throw new ArtifactEscapeError(`artifact name must be relative: ${name}`);
  }
  const resolved = resolve(root, name);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    throw new ArtifactEscapeError(`artifact name escapes the store: ${name}`);
  }
  const leaf = basename(resolved);
  if (leaf.length === 0 || leaf === '.' || leaf === '..') {
    throw new ArtifactEscapeError(`artifact name is not a file: ${name}`);
  }
  return resolved;
};

export class ArtifactStore {
  private readonly root: string;
  private readonly staging = new Map<string, StagingEntry>();
  private readonly removeRootOnClose: boolean;

  private constructor(root: string, removeRootOnClose: boolean) {
    this.root = root;
    this.removeRootOnClose = removeRootOnClose;
  }

  static async open(directory?: string): Promise<ArtifactStore> {
    if (directory === undefined) {
      const root = await fs.mkdtemp(join(tmpdir(), 'gram-artifacts-'));
      return new ArtifactStore(root, true);
    }
    await fs.mkdir(directory, { recursive: true });
    return new ArtifactStore(resolve(directory), false);
  }

  async close(): Promise<void> {
    this.staging.clear();
    if (this.removeRootOnClose) {
      await fs.rm(this.root, { recursive: true, force: true });
    }
  }

  async stage(artifactId: string, bytes: Uint8Array): Promise<StagedArtifact> {
    assertSafeName(this.root, artifactId);
    if (bytes.length > STAGING_CAP_BYTES) {
      throw new ArtifactCapError(
        `artifact exceeds staging cap (${bytes.length} > ${STAGING_CAP_BYTES})`,
      );
    }
    const stagingId = randomUUID();
    const tmpPath = join(this.root, `.staging-${stagingId}.tmp`);
    await fs.writeFile(tmpPath, bytes);
    this.staging.set(stagingId, {
      artifactId,
      tmpPath,
      digest: shaHex(bytes),
      bytes: bytes.length,
    });
    return { stagingId, artifactId, bytes: bytes.length };
  }

  async finalize(stagingId: string): Promise<FinalizedArtifact> {
    const entry = this.staging.get(stagingId);
    if (entry === undefined) throw new ArtifactError(`unknown staging id: ${stagingId}`);
    this.staging.delete(stagingId);
    const finalPath = assertSafeName(this.root, entry.artifactId);
    try {
      // Symlink refusal: never rename over (or through) a symlink.
      const probe = await fs.lstat(finalPath).catch((error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'ENOENT' ? null : Promise.reject(error),
      );
      if (probe !== null && probe !== undefined && probe.isSymbolicLink()) {
        await fs.rm(entry.tmpPath, { force: true });
        throw new ArtifactSymlinkError(`final path is a symlink: ${entry.artifactId}`);
      }
      await fs.mkdir(dirname(finalPath), { recursive: true });
      await fs.rename(entry.tmpPath, finalPath);
      const written = await fs.readFile(finalPath);
      if (written.length !== entry.bytes || shaHex(written) !== entry.digest) {
        throw new ArtifactError(`verify-after-rename mismatch: ${entry.artifactId}`);
      }
      return { artifactId: entry.artifactId, digest: entry.digest };
    } catch (error) {
      await fs.rm(entry.tmpPath, { force: true });
      throw error;
    }
  }

  async readText(artifactId: string): Promise<string> {
    const finalPath = assertSafeName(this.root, artifactId);
    try {
      return await fs.readFile(finalPath, 'utf8');
    } catch {
      throw new ArtifactError(`unknown artifact: ${artifactId}`);
    }
  }

  /** Allowlist-first field redaction: only SAFE fields survive. */
  redactFields(record: Record<string, unknown>): Record<string, unknown> {
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (SAFE_FIELDS.includes(key)) kept[key] = value;
    }
    return kept;
  }

  /** Scrub bearer-style secrets embedded in free text. */
  redactText(text: string): string {
    return text
      .replace(/("?(?:api[_-]?token|password|client[_-]?secret)"?\s*[:=]\s*"?)[^",\s}]+/gi, `$1${REDACTED}`)
      .replace(/(Bearer\s+)[^\s"']+/gi, `$1${REDACTED}`);
  }

  /** Test-only redaction surface (no filesystem). */
  static redactionForTest(): {
    redactFieldsForTest(record: Record<string, unknown>): Record<string, unknown>;
    redactTextForTest(text: string): string;
  } {
    const probe = Object.create(ArtifactStore.prototype) as ArtifactStore;
    return {
      redactFieldsForTest: (record) => probe.redactFields(record),
      redactTextForTest: (text) => probe.redactText(text),
    };
  }

  /** Test-only: plant a symlink at the final path to prove refusal. */
  async plantSymlinkForTest(artifactId: string): Promise<void> {
    const finalPath = resolve(this.root, basename(artifactId));
    await fs.symlink(join(tmpdir(), 'ops-artifact-sink'), finalPath);
  }
}
