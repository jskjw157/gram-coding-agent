import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export interface RecoveryContext {
  rootId: string; rootIdentity: string; path: string; sourceIdentity: string | null;
  operation: 'write' | 'trash' | 'copy' | 'restore' | 'directory';
}
const denied = () => new Error('Recovery operation denied');
const identity = (fd: number) => {const st = fstatSync(fd, { bigint: true });return st.dev + ':' + st.ino;};
const LIMIT = 2 * 1024 * 1024;
function context(input: RecoveryContext): RecoveryContext {
  const keys = ['rootId', 'rootIdentity', 'path', 'sourceIdentity', 'operation'];
  if (!input || Object.keys(input).length !== keys.length || Object.keys(input).some(k => !keys.includes(k)) ||
      !/^[a-z][a-z0-9_-]{0,31}$/u.test(input.rootId) || !/^\d+:\d+$/u.test(input.rootIdentity) ||
      (input.sourceIdentity !== null && !/^\d+:\d+$/u.test(input.sourceIdentity)) ||
      typeof input.path !== 'string' || !input.path || input.path.length > 2048 ||
      input.path.split('/').some(p => !p || p === '.' || p === '..') || /[\\:]/u.test(input.path) ||
      Array.from(input.path).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
      !['write', 'trash', 'copy', 'restore', 'directory'].includes(input.operation)) throw denied();
  return { rootId: input.rootId, rootIdentity: input.rootIdentity, path: input.path,
    sourceIdentity: input.sourceIdentity, operation: input.operation };
}
function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {const count = writeSync(fd, bytes, offset, bytes.length - offset);if (!count) throw denied();offset += count;}
  fsyncSync(fd);
}

/** Controller-private encrypted preimages. Not an MCP read port. Creating a
 * record verifies decryption before the caller is allowed to mutate its target. */
export class LocalRecoveryStore {
  private readonly directory: string;
  private readonly directoryIdentity: string;
  private readonly key: Buffer;
  constructor(options: { stateDirectory: string }) {
    this.directory = join(resolve(options.stateDirectory), 'local-owner-recovery');
    let parent: number | undefined;let folder: number | undefined;let keyFile: number | undefined;
    try {
      if (!isAbsolute(options.stateDirectory) || realpathSync(options.stateDirectory) !== resolve(options.stateDirectory)) throw denied();
      parent = openSync(options.stateDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const st = fstatSync(parent, { bigint: true });
      if (st.uid !== BigInt(process.getuid?.() ?? -1) || (st.mode & 0o022n) !== 0n) throw denied();
      const path = '/proc/self/fd/' + parent + '/local-owner-recovery';
      try {mkdirSync(path, { mode: 0o700 });}
      catch (error) {if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw denied();}
      folder = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      this.checkDirectory(folder);this.directoryIdentity = identity(folder);
      const keyPath = '/proc/self/fd/' + folder + '/recovery.key';
      try {
        keyFile = openSync(keyPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        writeAll(keyFile, randomBytes(32));closeSync(keyFile);keyFile = undefined;fsyncSync(folder);
      } catch (error) {if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw denied();}
      keyFile = openSync(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      this.checkFile(keyFile, 32);this.key = readFileSync(keyFile);
      if (this.key.length !== 32) throw denied();
    } catch {throw denied();}
    finally {if (keyFile !== undefined) closeSync(keyFile);if (folder !== undefined) closeSync(folder);if (parent !== undefined) closeSync(parent);}
  }
  private checkDirectory(fd: number): void {
    const st = fstatSync(fd, { bigint: true });
    if (!st.isDirectory() || st.uid !== BigInt(process.getuid?.() ?? -1) || (st.mode & 0o077n) !== 0n ||
        realpathSync('/proc/self/fd/' + fd) !== this.directory) throw denied();
  }
  private checkFile(fd: number, max: number): void {
    const st = fstatSync(fd, { bigint: true });
    if (!st.isFile() || st.nlink !== 1n || st.uid !== BigInt(process.getuid?.() ?? -1) ||
        (st.mode & 0o077n) !== 0n || st.size > BigInt(max)) throw denied();
  }
  private folder(): number {
    const fd = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {this.checkDirectory(fd);if (identity(fd) !== this.directoryIdentity) throw denied();return fd;}
    catch {closeSync(fd);throw denied();}
  }
  version(input: RecoveryContext, bytes: Buffer): string {
    return this.digest(input, 'content', bytes);
  }
  binding(input: RecoveryContext, bytes: Buffer): string {
    return this.digest(input, 'request', bytes);
  }
  pathFingerprint(input: RecoveryContext): string {
    return this.digest(input, 'path', Buffer.alloc(0));
  }
  private digest(input: RecoveryContext, purpose: 'content' | 'request' | 'path', bytes: Buffer): string {
    try {
      const target = context(input);
      return createHmac('sha256', this.key).update('owner-' + purpose + '/v1\0')
        .update(JSON.stringify({ rootId: target.rootId, rootIdentity: target.rootIdentity, path: target.path }))
        .update('\0').update(bytes).digest('hex');
    }
    catch {throw denied();}
  }
  capture(input: RecoveryContext, bytes: Buffer): { recoveryId: string } {
    let folder: number | undefined;let output: number | undefined;
    try {
      const binding = context(input);if (bytes.length > LIMIT) throw denied();
      const recoveryId = randomUUID();const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
      cipher.setAAD(Buffer.from('gram-owner-recovery/v1/' + recoveryId));
      const payload = Buffer.from(JSON.stringify({ context: binding, base64: bytes.toString('base64') }));
      const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
      const envelope = JSON.stringify({ version: 1, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
      folder = this.folder();output = openSync('/proc/self/fd/' + folder + '/' + recoveryId + '.json',
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeAll(output, Buffer.from(envelope));closeSync(output);output = undefined;fsyncSync(folder);
      if (!this.read(recoveryId, binding).equals(bytes)) throw denied();
      return { recoveryId };
    } catch {throw denied();}
    finally {if (output !== undefined) closeSync(output);if (folder !== undefined) closeSync(folder);}
  }
  read(recoveryId: string, expectedContext: RecoveryContext): Buffer {
    const expected = context(expectedContext);
    const record = this.readRecord(recoveryId);
    if (JSON.stringify(record.context) !== JSON.stringify(expected)) throw denied();
    return record.bytes;
  }
  /** Internal restoration only; never expose decrypted records through MCP. */
  readForTarget(recoveryId: string, target: Pick<RecoveryContext, 'rootId' | 'rootIdentity' | 'path'>) {
    const record = this.readRecord(recoveryId);
    if (record.context.rootId !== target.rootId || record.context.rootIdentity !== target.rootIdentity ||
        record.context.path !== target.path) throw denied();
    return record;
  }
  private readRecord(recoveryId: string): { context: RecoveryContext; bytes: Buffer } {
    let folder: number | undefined;let file: number | undefined;
    try {
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(recoveryId)) throw denied();
      folder = this.folder();
      file = openSync('/proc/self/fd/' + folder + '/' + recoveryId + '.json', constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      this.checkFile(file, 4 * LIMIT);
      const value = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown; nonce?: unknown; tag?: unknown; ciphertext?: unknown };
      if (value.version !== 1 || typeof value.nonce !== 'string' || typeof value.tag !== 'string' || typeof value.ciphertext !== 'string') throw denied();
      const nonce = Buffer.from(value.nonce, 'base64');const tag = Buffer.from(value.tag, 'base64');
      if (nonce.length !== 12 || tag.length !== 16) throw denied();
      const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
      decipher.setAAD(Buffer.from('gram-owner-recovery/v1/' + recoveryId));decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]);
      const decoded = JSON.parse(plaintext.toString('utf8')) as { context: RecoveryContext; base64: unknown };
      const validated = context(decoded.context);
      if (typeof decoded.base64 !== 'string') throw denied();
      const bytes = Buffer.from(decoded.base64, 'base64');if (bytes.length > LIMIT || bytes.toString('base64') !== decoded.base64) throw denied();
      return { context: validated, bytes };
    } catch {throw denied();}
    finally {if (file !== undefined) closeSync(file);if (folder !== undefined) closeSync(folder);}
  }
}
