import { lstat, readFile } from 'node:fs/promises';
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

    const stat = await lstat(secretPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Secret must be a regular file: ${name}`);
    }

    const permissions = stat.mode & 0o777;
    if ((permissions & ~0o600) !== 0) {
      throw new Error(`Secret file permissions must be 0600 or stricter: ${name}`);
    }

    const bytes = await readFile(secretPath);
    return new BufferSecretLease(bytes);
  }
}
