import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import type { CredentialName, SecretLease, SecretProvider } from './secret-provider.js';

const VALID_CREDENTIAL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

class BufferSecretLease implements SecretLease {
  private disposed = false;

  constructor(private readonly bytes: Buffer) {}

  withValue<T>(use: (value: string) => T): T {
    if (this.disposed) throw new Error('Secret lease has been disposed');
    const value = this.bytes.toString('utf8').replace(/\r?\n$/, '');
    return use(value);
  }

  dispose(): void {
    if (this.disposed) return;
    this.bytes.fill(0);
    this.disposed = true;
  }
}

export class FileSecretProvider implements SecretProvider {
  private readonly root: string;

  constructor(baseDirectory: string) {
    this.root = path.resolve(baseDirectory);
  }

  async getForUse(name: CredentialName): Promise<SecretLease> {
    if (!VALID_CREDENTIAL_NAME.test(name) || name === '.' || name === '..') {
      throw new Error(`Invalid credential name: ${name}`);
    }

    const secretPath = path.resolve(this.root, name);
    if (path.dirname(secretPath) !== this.root) {
      throw new Error(`Invalid credential name: ${name}`);
    }

    // Validate and read the same inode. O_NONBLOCK also prevents a substituted
    // FIFO from hanging before its file type can be rejected.
    const file = await open(secretPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) {
        throw new Error(`Secret must be a regular file: ${name}`);
      }
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw new Error(`Secret file must be owned by the current user: ${name}`);
      }
      if (stat.nlink !== 1) {
        throw new Error(`Secret file must not have additional hard links: ${name}`);
      }

      const permissions = stat.mode & 0o777;
      if ((permissions & ~0o600) !== 0) {
        throw new Error(`Secret file permissions must be 0600 or stricter: ${name}`);
      }

      const bytes = await file.readFile();
      return new BufferSecretLease(bytes);
    } finally {
      await file.close();
    }
  }
}
