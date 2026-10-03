import { createHash } from 'node:crypto';
import type { Role, ServiceConfig } from './contracts.js';
import { parseConfig } from './config.js';
import { renderPlist } from './launchd-plist.js';
import type { LocalAccount } from './adapters/macos-inspection.js';
import type { RegistryObservation } from './adapters/macos-service-probes.js';
import type { PathPresence } from './adapters/trusted-presence.js';

export type InstallFile = 'configuration' | 'manifest' | 'journal' | 'core' | 'tunnel';
export interface InstallationIO {
  presence(file: InstallFile): Promise<PathPresence>;
  read(file: InstallFile, limit: number): Promise<Buffer>;
  registry(): Promise<RegistryObservation | null>;
  verifyRelease(config: ServiceConfig): Promise<boolean>;
}
export interface InstallationEvidence {
  owned: true; safePaths: true; digest: string | null;
  present: Record<Role, boolean>; enabled: Record<Role, boolean>;
}
const files: readonly InstallFile[] = ['configuration', 'manifest', 'journal', 'core', 'tunnel'];
const roles: readonly Role[] = ['core', 'tunnel'];
const LIMIT = 262144;
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function refuse(): never { throw new Error('FOREIGN_SERVICE'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) refuse();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || keys.some(k => !own.includes(k))) refuse();
  const output: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !d.enumerable || !('value' in d)) refuse();
    output[key] = d.value;
  }
  return output;
}
function json(bytes: Buffer): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}
function registry(value: unknown): RegistryObservation {
  const r = record(value, ['jobs', 'overrides']);
  const jobs = record(r.jobs, roles); const overrides = record(r.overrides, roles);
  // Running jobs require Task 4 established-peer proof, not a matching label.
  if (roles.some(role => jobs[role] !== 'absent'
    || !(overrides[role] === null || typeof overrides[role] === 'boolean'))) refuse();
  return { jobs: { core: 'absent', tunnel: 'absent' },
    overrides: { core: overrides.core as boolean | null, tunnel: overrides.tunnel as boolean | null } };
}

/** Static installation identity for pristine or explicitly stopped installs.
 * INTERNAL: IO must establish descriptor/ACL trust. Never grants process
 * ownership or mutation authority. Task 6 must use this closed read contract.
 * Snapshot checks detect drift; they do not reserve files against trusted root.
 */
export async function inspectInstallation(account: LocalAccount, io: InstallationIO): Promise<InstallationEvidence> {
  try {
    const a = record(account, ['name', 'uid', 'gid', 'admin', 'groupsComplete']);
    if (a.name !== 'gram-agent' || a.admin !== false || a.groupsComplete !== true
      || typeof a.uid !== 'number' || !Number.isSafeInteger(a.uid) || a.uid <= 0 || a.uid >= 0xffff_ffff
      || typeof a.gid !== 'number' || !Number.isSafeInteger(a.gid) || a.gid < 0 || a.gid >= 0xffff_ffff) refuse();
    const firstRegistry = registry(await io.registry());
    const presence = {} as Record<InstallFile, PathPresence>;
    for (const key of files) {
      const value = await io.presence(key);
      if (value !== 'absent' && value !== 'file') refuse();
      presence[key] = value;
    }
    const snapshots = new Map<InstallFile, Buffer>();
    const read = async (key: InstallFile): Promise<Buffer> => {
      const value = await io.read(key, LIMIT);
      if (!Buffer.isBuffer(value) || value.length === 0 || value.length > LIMIT) refuse();
      return Buffer.from(value);
    };
    const present = { core: false, tunnel: false };
    if (presence.manifest === 'absent') {
      if (files.some(key => presence[key] !== 'absent')
        || roles.some(role => firstRegistry.overrides[role] !== null)) refuse();
    } else {
      if (presence.configuration !== 'file' || presence.core !== 'file') refuse();
      for (const key of files) if (presence[key] === 'file') snapshots.set(key, await read(key));
      const manifestBytes = snapshots.get('manifest'); const configBytes = snapshots.get('configuration');
      if (!manifestBytes || !configBytes) refuse();
      const m = record(json(manifestBytes), ['schemaVersion', 'state', 'runtime', 'configSha256',
        'releaseId', 'releaseDigest', 'plistSha256', 'desiredEnabled']);
      const runtime = record(m.runtime, ['name', 'uid', 'gid']);
      const hashes = record(m.plistSha256, roles); const enabled = record(m.desiredEnabled, roles);
      if (m.schemaVersion !== 1 || m.state !== 'COMMITTED' || runtime.name !== a.name
        || runtime.uid !== a.uid || runtime.gid !== a.gid || m.configSha256 !== sha(configBytes)
        || enabled.core !== false || enabled.tunnel !== false) refuse();
      const config = parseConfig(json(configBytes));
      if (m.releaseId !== config.releaseId || m.releaseDigest !== config.releaseDigest) refuse();
      present.core = true; present.tunnel = config.tunnel.enabled;
      for (const role of roles) {
        const bytes = snapshots.get(role);
        if (present[role]) {
          if (!bytes || firstRegistry.overrides[role] !== true || hashes[role] !== sha(bytes)
            || !bytes.equals(Buffer.from(renderPlist(config, role)))) refuse();
        } else if (presence[role] !== 'absent' || hashes[role] !== null || firstRegistry.overrides[role] !== null) refuse();
      }
      const journal = snapshots.get('journal');
      if (journal) {
        const j = record(json(journal), ['schemaVersion', 'stage', 'installationDigest']);
        if (j.schemaVersion !== 1 || j.stage !== 'COMMITTED' || j.installationDigest !== sha(manifestBytes)) refuse();
      }
      // Root-controlled installed records anchor the old release digest; the
      // native IO must still verify its full inventory/content, not its name.
      if (await io.verifyRelease(parseConfig(config)) !== true) refuse();
    }
    for (const key of files) {
      if (await io.presence(key) !== presence[key]) refuse();
      const before = snapshots.get(key);
      if (before && !before.equals(await read(key))) refuse();
    }
    if (JSON.stringify(registry(await io.registry())) !== JSON.stringify(firstRegistry)) refuse();
    const digest = presence.manifest === 'absent' ? null : sha(JSON.stringify({
      files: files.map(key => [key, snapshots.has(key) ? sha(snapshots.get(key) as Buffer) : null]),
      registry: firstRegistry,
    }));
    return { owned: true, safePaths: true, digest, present, enabled: { core: false, tunnel: false } };
  } catch { return refuse(); }
}
