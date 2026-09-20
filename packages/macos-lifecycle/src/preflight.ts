import { createHash } from 'node:crypto';
import type { Preview, Role, SafeCode, ServiceConfig } from './contracts.js';
import { parseConfig } from './config.js';
import type { Inspector, PreflightFacts } from './inspection-contracts.js';
import { renderPlist } from './launchd-plist.js';

export function firstRefusal(facts: PreflightFacts): SafeCode {
  if (facts.nativeMac !== true || facts.node24 !== true) return 'UNSUPPORTED_HOST';
  if (facts.validAccount !== true) return 'ACCOUNT_INVALID';
  if (facts.trustedRelease !== true) return 'UNTRUSTED_RELEASE';
  if (facts.safePaths !== true) return 'UNSAFE_PATH';
  if (facts.ownedInstallation !== true) return 'FOREIGN_SERVICE';
  if (facts.freeOrOwnedPorts !== true) return 'PORT_IN_USE';
  return 'OK';
}
function data(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return {};
  const output: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return {};
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return {};
    output[key] = descriptor.value;
  }
  return output;
}
function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
function accountNumber(value: unknown, minimum: number): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value < 0xffff_ffff;
}
function roleFlags(value: unknown): Record<Role, boolean> | null {
  const flags = data(value);
  if (Object.keys(flags).length !== 2 || typeof flags.core !== 'boolean' || typeof flags.tunnel !== 'boolean') return null;
  return { core: flags.core, tunnel: flags.tunnel };
}

/** Decision layer only. Inspector must be a trusted, read-only native adapter.
 * A successful result is a review token, never installation authorization.
 * No real native inspector is constructed by this function.
 */
export async function preview(config: ServiceConfig, expectedDigest: string, inspector: Inspector): Promise<Preview> {
  const refused = (code: SafeCode): Preview => ({ ok: false, code, configDigest: '',
    previousInstallDigest: null, releaseDigest: '', roles: [] });
  let stage: SafeCode = 'INVALID_CONFIG';
  try {
    const normalized = parseConfig(config);
    if (!isDigest(expectedDigest) || expectedDigest !== normalized.releaseDigest) return refused('UNTRUSTED_RELEASE');
    const facts: PreflightFacts = { nativeMac: false, node24: false, validAccount: false,
      trustedRelease: false, safePaths: false, ownedInstallation: false, freeOrOwnedPorts: false };
    stage = 'UNSUPPORTED_HOST';
    const host = data(await inspector.host());
    facts.nativeMac = host.platform === 'darwin' && host.arch === 'arm64';
    facts.node24 = typeof host.nodeVersion === 'string' && /^24\.[0-9]+\.[0-9]+$/.test(host.nodeVersion);
    if (!facts.nativeMac || !facts.node24) return refused(firstRefusal(facts));

    stage = 'ACCOUNT_INVALID';
    const account = data(await inspector.account());
    facts.validAccount = account.name === 'gram-agent' && accountNumber(account.uid, 1)
      && accountNumber(account.gid, 0) && account.admin === false && account.groupsComplete === true;
    if (!facts.validAccount) return refused(firstRefusal(facts));

    stage = 'UNTRUSTED_RELEASE';
    // Adapters receive copies, never the configuration later rendered and hashed.
    const release = data(await inspector.release(parseConfig(normalized), expectedDigest));
    facts.trustedRelease = release.verified === true && release.digest === expectedDigest;
    if (!facts.trustedRelease) return refused(firstRefusal(facts));
    if (release.safePaths !== true) return refused('UNSAFE_PATH');

    stage = 'FOREIGN_SERVICE';
    const installation = data(await inspector.installation());
    facts.safePaths = installation.safePaths === true;
    if (!facts.safePaths) return refused(firstRefusal(facts));
    const present = roleFlags(installation.present);
    const enabled = roleFlags(installation.enabled);
    const previousInstallDigest = installation.digest;
    facts.ownedInstallation = installation.owned === true && present !== null && enabled !== null
      && (previousInstallDigest === null || isDigest(previousInstallDigest));
    if (!facts.ownedInstallation || present === null || enabled === null) return refused('FOREIGN_SERVICE');
    if ((present.core || present.tunnel) && previousInstallDigest === null) return refused('FOREIGN_SERVICE');
    if ((enabled.core && !present.core) || (enabled.tunnel && !present.tunnel)
      || (present.tunnel && !present.core) || (enabled.tunnel && !enabled.core)) return refused('FOREIGN_SERVICE');

    const roles: Role[] = normalized.tunnel.enabled ? ['core', 'tunnel'] : ['core'];
    stage = 'PORT_IN_USE';
    const ports = data(await inspector.ports([...roles]));
    facts.freeOrOwnedPorts = roles.every(role => ports[role] === 'free'
      || (ports[role] === 'owned' && present[role] && enabled[role]));
    if (!facts.freeOrOwnedPorts) return refused(firstRefusal(facts));

    stage = 'INVALID_CONFIG';
    if (await inspector.plistValidity(roles.map(role => renderPlist(normalized, role))) !== true) return refused(stage);
    const code = firstRefusal(facts);
    if (code !== 'OK' || !(previousInstallDigest === null || isDigest(previousInstallDigest))) return refused(code);
    // This preview field is the composite review token, not configDigest(config).
    const reviewDigest = createHash('sha256').update(JSON.stringify({
      config: normalized, releaseDigest: expectedDigest, previousInstallDigest,
    }), 'utf8').digest('hex');
    return { ok: true, code: 'OK', configDigest: reviewDigest, previousInstallDigest,
      releaseDigest: expectedDigest, roles };
  } catch {
    return refused(stage);
  }
}
