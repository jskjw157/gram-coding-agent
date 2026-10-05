// artifact-store.test.ts — MAC-03 WP-12 RED: artifact store
// (tmp -> verify -> rename, traversal/symlink refusal, 64KiB staging cap,
// allowlist-first redaction).
import { describe, expect, it } from 'vitest';
import {
  ArtifactCapError,
  ArtifactEscapeError,
  ArtifactStore,
  ArtifactSymlinkError,
  STAGING_CAP_BYTES,
} from './artifact-store.js';

describe('ArtifactStore staging cap', () => {
  it('exposes a 64KiB staging cap', () => {
    expect(STAGING_CAP_BYTES).toBe(64 * 1024);
  });

  it('stages and finalizes a small artifact with a digest', async () => {
    const store = await ArtifactStore.open();
    try {
      const staged = await store.stage('report.txt', Buffer.from('hello fixture'));
      const finalized = await store.finalize(staged.stagingId);
      expect(finalized.artifactId).toBe('report.txt');
      expect(finalized.digest.length).toBeGreaterThan(0);
      expect(await store.readText(finalized.artifactId)).toBe('hello fixture');
    } finally {
      await store.close();
    }
  });

  it('refuses payloads over the staging cap', async () => {
    const store = await ArtifactStore.open();
    try {
      await expect(store.stage('big.bin', Buffer.alloc(STAGING_CAP_BYTES + 1))).rejects.toThrow(
        ArtifactCapError,
      );
    } finally {
      await store.close();
    }
  });
});

describe('ArtifactStore traversal and symlink refusal', () => {
  it('refuses path escape names', async () => {
    const store = await ArtifactStore.open();
    try {
      await expect(store.stage('../escape.txt', Buffer.from('x'))).rejects.toThrow(
        ArtifactEscapeError,
      );
      await expect(store.stage('/absolute.txt', Buffer.from('x'))).rejects.toThrow(
        ArtifactEscapeError,
      );
      await expect(store.stage('sub/../../escape.txt', Buffer.from('x'))).rejects.toThrow(
        ArtifactEscapeError,
      );
    } finally {
      await store.close();
    }
  });

  it('refuses to finalize through a symlinked final path', async () => {
    const store = await ArtifactStore.open();
    try {
      const staged = await store.stage('linked.txt', Buffer.from('payload'));
      await store.plantSymlinkForTest('linked.txt');
      await expect(store.finalize(staged.stagingId)).rejects.toThrow(ArtifactSymlinkError);
    } finally {
      await store.close();
    }
  });
});

describe('ArtifactStore allowlist-first redaction', () => {
  it('redacts secret-looking fields and keeps allowlisted ones', () => {
    const store = ArtifactStore.redactionForTest();
    const redacted = store.redactFieldsForTest({
      recipeId: 'recipe-fixture-echo',
      apiToken: 'super-secret',
      password: 'hunter2',
    });
    expect(redacted).toEqual({ recipeId: 'recipe-fixture-echo' });
  });

  it('redacts bearer secrets embedded in text', () => {
    const store = ArtifactStore.redactionForTest();
    expect(store.redactTextForTest('call with Bearer abc123 now')).not.toContain('abc123');
  });
});
