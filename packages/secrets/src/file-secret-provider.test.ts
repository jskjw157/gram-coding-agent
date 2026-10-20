import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileSecretProvider } from './file-secret-provider.js';

const dirs: string[] = [];

function tempSecretDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gram-secrets-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  let dir: string | undefined;
  while ((dir = dirs.pop()) !== undefined) rmSync(dir, { recursive: true, force: true });
});

describe('FileSecretProvider', () => {
  it('rejects a secret inode also reachable through another hard link', async () => {
    const dir = tempSecretDir();
    const outside = join(tempSecretDir(), 'outside-token');
    writeFileSync(outside, 'synthetic-hardlink-canary', { mode: 0o600 });
    linkSync(outside, join(dir, 'github_token'));

    // A private secret must have one name: an alias outside the secret root
    // can otherwise retain access when the configured pathname is replaced.
    await expect(new FileSecretProvider(dir).getForUse('github_token'))
      .rejects.toThrow(/hard link/i);
  });

  it('rejects a final symlink to a private regular file', async () => {
    const dir = tempSecretDir();
    const target = join(tempSecretDir(), 'target-token');
    writeFileSync(target, 'synthetic-symlink-canary', { mode: 0o600 });
    symlinkSync(target, join(dir, 'github_token'));

    await expect(new FileSecretProvider(dir).getForUse('github_token')).rejects.toThrow();
  });

  it('leases a 0600 secret without exposing a public value property', async () => {
    const dir = tempSecretDir();
    const path = join(dir, 'github_token');
    writeFileSync(path, 'secret-token\n', { mode: 0o600 });
    const provider = new FileSecretProvider(dir);

    const lease = await provider.getForUse('github_token');
    expect('value' in lease).toBe(false);
    expect(lease.withValue((value) => value)).toBe('secret-token');
    lease.dispose();
    expect(() => lease.withValue((value) => value)).toThrow(/disposed/i);
  });

  it('rejects secret files that are more permissive than 0600', async () => {
    const dir = tempSecretDir();
    const path = join(dir, 'unsafe_token');
    writeFileSync(path, 'unsafe', { mode: 0o600 });
    chmodSync(path, 0o644);
    const provider = new FileSecretProvider(dir);

    await expect(provider.getForUse('unsafe_token')).rejects.toThrow(/permissions/i);
  });

  it('rejects credential names that could escape the configured secret directory', async () => {
    const provider = new FileSecretProvider(tempSecretDir());
    await expect(provider.getForUse('../outside')).rejects.toThrow(/credential name/i);
  });
});
