import { createHash } from 'node:crypto';
import type { Role, ServiceConfig } from '../contracts.js';
import { parseConfig } from '../config.js';
import { renderPlist } from '../launchd-plist.js';

/** Fixed installation files. Journal-controlled arbitrary path writes or
 * deletes are forbidden: only these generated fixed names are addressable.
 * Callers supply bytes; this module validates exact keys, sizes, and hashes.
 */
export const FIXED_FILES = Object.freeze({
  configuration: 'config/service.json',
  manifest: 'config/installation.json',
  journal: 'config/install-journal.json',
  core: 'Library/LaunchDaemons/com.haar.gram-agent.core.plist',
  tunnel: 'Library/LaunchDaemons/com.haar.gram-agent.tunnel.plist',
} as const);

export type FixedKind = keyof typeof FIXED_FILES;

export const INSTALL_LIMIT = 262144;

export function shaBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && keys.every(k => Object.hasOwn(value, k));
}

export interface BuiltManifest {
  bytes: Buffer;
  sha: string;
}

export function canonicalConfigBytes(config: ServiceConfig): Buffer {
  const normalized = parseConfig(config);
  return Buffer.from(JSON.stringify(normalized), 'utf8');
}

export function expectedPlistBytes(config: ServiceConfig, role: Role): Buffer | null {
  const normalized = parseConfig(config);
  if (role === 'tunnel' && !normalized.tunnel.enabled) return null;
  return Buffer.from(renderPlist(normalized, role), 'utf8');
}

/** Final manifest exact keys only. Runtime name is gram-agent; absent tunnel
 * hash is null; actual bytes hashes bind content.
 */
export function buildManifest(input: {
  runtime: { name: 'gram-agent'; uid: number; gid: number };
  configBytes: Buffer;
  releaseId: string;
  releaseDigest: string;
  corePlist: Buffer;
  tunnelPlist: Buffer | null;
}): BuiltManifest {
  if (input.runtime.name !== 'gram-agent') throw new Error('FOREIGN_SERVICE');
  if (!Number.isSafeInteger(input.runtime.uid) || input.runtime.uid <= 0 || input.runtime.uid >= 0xffff_ffff) throw new Error('FOREIGN_SERVICE');
  if (!Number.isSafeInteger(input.runtime.gid) || input.runtime.gid < 0 || input.runtime.gid >= 0xffff_ffff) throw new Error('FOREIGN_SERVICE');
  if (!Buffer.isBuffer(input.configBytes) || input.configBytes.length === 0
    || input.configBytes.length > INSTALL_LIMIT) throw new Error('INVALID_CONFIG');
  if (!Buffer.isBuffer(input.corePlist) || input.corePlist.length === 0
    || input.corePlist.length > INSTALL_LIMIT) throw new Error('INVALID_CONFIG');
  if (input.tunnelPlist !== null
    && (!Buffer.isBuffer(input.tunnelPlist) || input.tunnelPlist.length > INSTALL_LIMIT)) {
    throw new Error('INVALID_CONFIG');
  }
  const manifest = {
    schemaVersion: 1,
    state: 'COMMITTED',
    runtime: { name: 'gram-agent', uid: input.runtime.uid, gid: input.runtime.gid },
    configSha256: shaBytes(input.configBytes),
    releaseId: input.releaseId,
    releaseDigest: input.releaseDigest,
    plistSha256: {
      core: shaBytes(input.corePlist),
      tunnel: input.tunnelPlist === null ? null : shaBytes(input.tunnelPlist),
    },
    desiredEnabled: { core: false, tunnel: false },
  };
  const bytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  if (bytes.length > INSTALL_LIMIT) throw new Error('INVALID_CONFIG');
  return { bytes, sha: shaBytes(bytes) };
}

export function validateManifestBytes(bytes: Buffer): boolean {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > INSTALL_LIMIT) return false;
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!isRecord(parsed)) return false;
    if (!exactKeys(parsed, ['schemaVersion', 'state', 'runtime', 'configSha256',
      'releaseId', 'releaseDigest', 'plistSha256', 'desiredEnabled'])) return false;
    if (parsed.schemaVersion !== 1 || parsed.state !== 'COMMITTED') return false;
    const runtime = parsed.runtime;
    if (!isRecord(runtime) || !exactKeys(runtime, ['name', 'uid', 'gid'])) return false;
    if (runtime.name !== 'gram-agent') return false;
    const uid = (runtime as Record<string, unknown>).uid;
    const gid = (runtime as Record<string, unknown>).gid;
    if (typeof uid !== 'number' || !Number.isSafeInteger(uid) || uid <= 0 || uid >= 0xffff_ffff) return false;
    if (typeof gid !== 'number' || !Number.isSafeInteger(gid) || gid < 0 || gid >= 0xffff_ffff) return false;
    const hashes = parsed.plistSha256;
    const enabled = parsed.desiredEnabled;
    if (!isRecord(hashes) || !exactKeys(hashes, ['core', 'tunnel'])) return false;
    if (!isRecord(enabled) || !exactKeys(enabled, ['core', 'tunnel'])) return false;
    if (enabled.core !== false || enabled.tunnel !== false) return false;
    const hex = (v: unknown): boolean => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
    if (!hex(parsed.configSha256) || typeof parsed.releaseId !== 'string' || !hex(parsed.releaseDigest)) return false;
    if (!hex(hashes.core)) return false;
    if (!(hashes.tunnel === null || hex(hashes.tunnel))) return false;
    return true;
  } catch {
    return false;
  }
}

export function buildCommittedJournal(manifestBytes: Buffer): Buffer {
  if (!validateManifestBytes(manifestBytes)) throw new Error('FOREIGN_SERVICE');
  const body = {
    schemaVersion: 1,
    stage: 'COMMITTED',
    installationDigest: shaBytes(manifestBytes),
  };
  const bytes = Buffer.from(JSON.stringify(body), 'utf8');
  if (bytes.length > INSTALL_LIMIT) throw new Error('INVALID_CONFIG');
  return bytes;
}

export function validateCommittedJournal(journal: Buffer, manifestBytes: Buffer): boolean {
  try {
    if (!Buffer.isBuffer(journal) || journal.length === 0 || journal.length > INSTALL_LIMIT) return false;
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(journal));
    if (!isRecord(parsed)) return false;
    if (!exactKeys(parsed, ['schemaVersion', 'stage', 'installationDigest'])) return false;
    return parsed.schemaVersion === 1 && parsed.stage === 'COMMITTED'
      && parsed.installationDigest === shaBytes(manifestBytes);
  } catch {
    return false;
  }
}

export function buildIntermediateJournal(stage: 'PREPARED' | 'STOPPED' | 'FILES_STAGED' | 'PUBLISHED' | 'STARTED', input: {
  previousDigest: string | null;
  nextDigest: string;
  inventory: readonly string[];
}): Buffer {
  const hexOrNull = (v: string | null): boolean => v === null || /^[a-f0-9]{64}$/.test(v);
  if (!hexOrNull(input.previousDigest) || !/^[a-f0-9]{64}$/.test(input.nextDigest)) throw new Error('INVALID_CONFIG');
  for (const name of input.inventory) {
    if (typeof name !== 'string' || name.length === 0 || name.length > 256) throw new Error('INVALID_CONFIG');
    if (!Object.values(FIXED_FILES).includes(name as (typeof FIXED_FILES)[FixedKind])) {
      throw new Error('FOREIGN_SERVICE');
    }
  }
  const bytes = Buffer.from(JSON.stringify({
    schemaVersion: 1, stage,
    previousDigest: input.previousDigest, nextDigest: input.nextDigest,
    inventory: [...input.inventory],
  }), 'utf8');
  if (bytes.length > INSTALL_LIMIT) throw new Error('INVALID_CONFIG');
  return bytes;
}
