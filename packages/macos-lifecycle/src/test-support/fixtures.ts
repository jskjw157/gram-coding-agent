import { parseConfig } from '../config.js';
import type { Inspector } from '../inspection-contracts.js';

export function labConfig() {
  return parseConfig({ schemaVersion: 1, mode: 'LAB_ONLY', runtimeUser: 'gram-agent',
    releaseId: 'lab-001', releaseDigest: 'a'.repeat(64), tunnel: { enabled: false } });
}
export function makeInspector(overrides: Partial<Record<keyof Inspector, unknown>> = {}) {
  const values: Record<keyof Inspector, unknown> = {
    host: { platform: 'darwin', arch: 'arm64', nodeVersion: '24.20.0' },
    account: { name: 'gram-agent', uid: 501, gid: 501, admin: false, groupsComplete: true },
    release: { verified: true, safePaths: true, digest: 'a'.repeat(64) },
    installation: { owned: true, safePaths: true, digest: null,
      present: { core: false, tunnel: false }, enabled: { core: false, tunnel: false } },
    ports: { core: 'free', tunnel: 'free' },
    plistValidity: true,
    ...overrides,
  };
  const reads: string[] = [];
  async function read(key: keyof Inspector): Promise<unknown> {
    reads.push(key);
    return values[key];
  }
  return {
    reads,
    host: () => read('host'), account: () => read('account'), release: () => read('release'),
    installation: () => read('installation'), ports: () => read('ports'),
    plistValidity: () => read('plistValidity'),
  } satisfies Inspector & { reads: string[] };
}
