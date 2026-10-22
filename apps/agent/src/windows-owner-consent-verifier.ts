import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import type { NativeOwnerChallenge, NativeOwnerPresenceResult, NativeOwnerPresenceVerifier } from './local-owner-consent.js';

export interface WindowsOwnerConsentOptions {
  helperPath: string;
  helperSha256: string;
  expectedOwnerSid: string;
  now?: () => number;
}
export interface ProtectedLocalViewRequest {
  target: NativeOwnerChallenge['target'];
  content: Buffer;
}
export interface WindowsProtectedLocalViewer {
  show(request: ProtectedLocalViewRequest): Promise<{ status: 'DISPLAYED' | 'DENIED' | 'UNAVAILABLE' }>;
}
const DENIED = { status: 'DENIED' } as const;
const HEX = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SID = /^S-1-(?:\d{1,15})(?:-\d{1,10}){1,15}$/u;
// Process-wide, shared by verifier and viewer instances. A timeout does not
// release this guard until the child has actually closed.
let active = false;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function path(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048 &&
    !/[\\:<>"|?*\p{Cc}\p{Cf}]/u.test(value) && value.split('/').every(part =>
      part !== '' && part !== '.' && part !== '..' && !/[. ]$/u.test(part));
}
function validChallenge(value: NativeOwnerChallenge, now: number): boolean {
  if (!record(value) || Object.keys(value).sort().join() !== 'bindingDigest,challengeId,expiresAt,issuedAt,target' ||
      typeof value.challengeId !== 'string' || !UUID.test(value.challengeId) ||
      typeof value.bindingDigest !== 'string' || !HEX.test(value.bindingDigest) ||
      !Number.isSafeInteger(now) || !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt) ||
      value.issuedAt < 0 || value.issuedAt > now || value.expiresAt <= now ||
      value.expiresAt - value.issuedAt > 120_000 || !record(value.target)) return false;
  const target = value.target;
  return Object.keys(target).sort().join() === 'action,destination,path,rootId' &&
    ['protected-reveal', 'credential-write', 'destructive', 'binary-export'].includes(target.action) &&
    /^[a-z][a-z0-9_-]{0,31}$/u.test(target.rootId) && path(target.path) &&
    (target.destination === null || path(target.destination));
}
function config(options: WindowsOwnerConsentOptions) {
  if (!isAbsolute(options.helperPath) || !options.helperPath.endsWith('.exe') ||
      !HEX.test(options.helperSha256) || !SID.test(options.expectedOwnerSid)) throw new Error('Invalid native owner configuration');
  return Object.freeze({ ...options, now: options.now ?? Date.now });
}
/** Trusted composition supplies a protected installed executable and digest.
 * Hash checks detect changes; install ACLs must prevent replacement between the
 * hash check and CreateProcess. This is not an ACL provisioning mechanism. */
function pin(options: ReturnType<typeof config>): () => void {
  const fd = openSync(options.helperPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 16n * 1024n * 1024n ||
        realpathSync(options.helperPath) !== options.helperPath) throw new Error('Denied');
    const digest = createHash('sha256').update(readFileSync(fd)).digest('hex');
    const after = fstatSync(fd, { bigint: true });
    if (digest !== options.helperSha256 || before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || after.nlink !== 1n) throw new Error('Denied');
    return () => closeSync(fd);
  } catch { closeSync(fd);throw new Error('Denied'); }
}
async function invoke(options: ReturnType<typeof config>, request: object, expiresAt: number): Promise<unknown> {
  if (active) return DENIED;
  active = true;
  let release: (() => void) | undefined;
  try {
    release = pin(options);
    const input = JSON.stringify(request);
    if (Buffer.byteLength(input) > 2 * 1024 * 1024) return DENIED;
    return await new Promise<unknown>(resolve => {
      const child = spawn(options.helperPath, [], { cwd: dirname(options.helperPath), env: {}, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let failed = false;let length = 0;const chunks: Buffer[] = [];
      const fail = () => { failed = true;chunks.length = 0;if (child.pid !== undefined) child.kill('SIGKILL'); };
      // Allow bounded native teardown after its own expiry timer closes the
      // viewer. This grace does not extend the accepted proof lifetime below.
      const timer = setTimeout(fail, Math.max(1, expiresAt - options.now()) + 1000);
      child.stdout.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > 1024) fail();else if (!failed) chunks.push(chunk);
      });
      child.stderr.on('data', fail);
      child.stdin.on('error', fail);
      child.on('error', fail);
      child.on('close', code => {
        clearTimeout(timer);
        if (failed || code !== 0) { resolve(DENIED);return; }
        try {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).trim();
          const parsed: unknown = JSON.parse(text);
          // Native emits canonical compact JSON. Re-encoding also rejects
          // duplicate keys, noncanonical numbers, and additional stdout frames.
          resolve(JSON.stringify(parsed) === text ? parsed : DENIED);
        } catch { resolve(DENIED); }
      });
      child.stdin.end(input);
    });
  } catch { return DENIED; }
  finally { release?.();active = false; }
}
export function createWindowsOwnerConsentVerifier(input: WindowsOwnerConsentOptions): NativeOwnerPresenceVerifier {
  const options = config(input);
  return async challenge => {
    try {
      const snapshot = structuredClone(challenge);
      if (!validChallenge(snapshot, options.now())) return DENIED;
      const result = await invoke(options, { operation: 'verify', ...snapshot, expectedOwnerSid: options.expectedOwnerSid }, snapshot.expiresAt);
      if (!record(result)) return DENIED;
      if (Object.keys(result).length === 1 && ['DENIED', 'CANCELLED', 'UNAVAILABLE'].includes(String(result.status))) return result as NativeOwnerPresenceResult;
      const now = options.now();
      if (Object.keys(result).sort().join() !== 'bindingDigest,challengeId,ownerId,status,verifiedAt' ||
          result.status !== 'VERIFIED' || result.challengeId !== snapshot.challengeId || result.bindingDigest !== snapshot.bindingDigest ||
          result.ownerId !== options.expectedOwnerSid || !Number.isSafeInteger(result.verifiedAt) ||
          (result.verifiedAt as number) < snapshot.issuedAt || (result.verifiedAt as number) > now ||
          !validChallenge(snapshot, now)) return DENIED;
      return result as NativeOwnerPresenceResult;
    } catch { return DENIED; }
  };
}
export function createWindowsProtectedLocalViewer(input: WindowsOwnerConsentOptions): WindowsProtectedLocalViewer {
  const options = config(input);
  return { async show(request) {
    try {
      const content = Buffer.from(request.content);
      if (content.length === 0 || content.length > 256 * 1024 || content.includes(0)) return DENIED;
      new TextDecoder('utf-8', { fatal: true }).decode(content);
      const issuedAt = options.now();
      const challenge = { challengeId: randomUUID(), bindingDigest: createHash('sha256').update(content).digest('hex'),
        issuedAt, expiresAt: issuedAt + 60_000, target: structuredClone(request.target) };
      if (!validChallenge(challenge, issuedAt) || challenge.target.action !== 'protected-reveal' || challenge.target.destination !== null) return DENIED;
      const result = await invoke(options, { operation: 'view', ...challenge, expectedOwnerSid: options.expectedOwnerSid,
        contentBase64: content.toString('base64') }, challenge.expiresAt);
      if (record(result) && Object.keys(result).length === 1 &&
          (result.status === 'DISPLAYED' || result.status === 'UNAVAILABLE')) return { status: result.status };
      return DENIED;
    } catch { return DENIED; }
  } };
}
