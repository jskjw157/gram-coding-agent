import { createHash } from 'node:crypto';
import { configDigest, parseConfig } from './config.js';
import type { RuntimeReview } from './adapters/runtime-authority.js';
export type { RuntimeReview } from './adapters/runtime-authority.js';

const MAX_BYTES = 65536;
const keys = ['config', 'configDigest', 'nodeDigest', 'fileAclDigest', 'peerOwnerDigest'] as const;
function invalid(): never { throw new Error('INVALID_RUNTIME_REVIEW'); }
function digest(value: unknown): value is string {
  return typeof value === 'string' && value.length === 64 && !/[^a-f0-9]/u.test(value);
}
function data(value: unknown, expected: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== expected.length || own.some(k => typeof k !== 'string' || !expected.includes(k))) invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
    result[key] = descriptor.value;
  }
  return result;
}

/** Validate and detach metadata only. This does NOT approve a deployment,
 * inspect files, execute a helper, read a credential or establish provenance.
 * Reused by the existing runtime authority so the in-memory and byte paths
 * cannot silently acquire different configuration/pin rules.
 */
export function copyRuntimeReview(value: unknown): Readonly<RuntimeReview> {
  try {
    const v = data(value, keys);
    const config = parseConfig(v.config);
    if (!digest(v.configDigest) || v.configDigest !== configDigest(config)
      || !digest(v.nodeDigest) || !digest(v.fileAclDigest) || !digest(v.peerOwnerDigest)) invalid();
    Object.freeze(config.tunnel); Object.freeze(config);
    return Object.freeze({ config, configDigest: v.configDigest, nodeDigest: v.nodeDigest,
      fileAclDigest: v.fileAclDigest, peerOwnerDigest: v.peerOwnerDigest });
  } catch { return invalid(); }
}

/** Private versioned metadata envelope, NOT release.json, installation.json,
 * ServiceConfig, a public CLI format or a store of raw authentication data.
 * A caller may persist these bytes only through its separately trusted writer.
 */
export function encodeRuntimeReview(value: unknown): Buffer {
  try {
    const review = copyRuntimeReview(value);
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, review }) + '\n', 'utf8');
    if (bytes.length > MAX_BYTES) invalid();
    return bytes;
  } catch { return invalid(); }
}

/** Exact-byte admission against an independently supplied expected digest.
 * Computing expectedDigest from the same untrusted input is NOT approval.
 * Canonical comparison rejects duplicate keys, BOM, alternate key order and
 * ignored fields. Absence/malformed/mismatch always returns null; no fallback,
 * authority generation, filesystem access or network use exists in this module.
 */
export function decodeRuntimeReview(bytes: Buffer, expectedDigest: string): Readonly<RuntimeReview> | null {
  try {
    if (!digest(expectedDigest) || !Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_BYTES) return null;
    const copy = Buffer.from(bytes);
    if (createHash('sha256').update(copy).digest('hex') !== expectedDigest) return null;
    const envelope = data(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(copy)), ['schemaVersion', 'review']);
    if (envelope.schemaVersion !== 1) return null;
    const review = copyRuntimeReview(envelope.review);
    if (!encodeRuntimeReview(review).equals(copy)) return null;
    return review;
  } catch { return null; }
}
