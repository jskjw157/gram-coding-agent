import { createHash } from 'node:crypto';
import { root, type ServiceConfig } from './contracts.js';
import { parseConfig } from './config.js';
import { inspectRelease } from './release-inspection.js';
import { createTrustedFiles, type AclProbe } from './adapters/trusted-files.js';

export const CANDIDATE_CONFIG_FILE = 'candidate-service.json';
export const systemCandidateConfigPath = `${root}/config/${CANDIDATE_CONFIG_FILE}`;

export interface CandidateConfigLayout {
  readonly anchor: string;
  readonly ownerUid: number;
  readonly appRelative: string;
  readonly acl: AclProbe;
}

export async function readCandidateConfigMetadataAt(
  layout: CandidateConfigLayout,
): Promise<ServiceConfig> {
  const configFiles = createTrustedFiles(
    layout.anchor,
    layout.ownerUid,
    layout.acl,
    `${layout.appRelative}/config`,
  );
  const bytes = await configFiles.read(CANDIDATE_CONFIG_FILE, 262_144);
  const config = parseConfig(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
  );
  const releaseFiles = createTrustedFiles(
    layout.anchor,
    layout.ownerUid,
    layout.acl,
    `${layout.appRelative}/releases/${config.releaseId}`,
  );
  const releaseJson = await releaseFiles.read('release.json', 1024 * 1024);
  if (createHash('sha256').update(releaseJson).digest('hex') !== config.releaseDigest) {
    throw new Error('UNTRUSTED_RELEASE');
  }
  return parseConfig(config);
}

export async function readCandidateConfigAt(
  layout: CandidateConfigLayout,
): Promise<ServiceConfig> {
  const configFiles = createTrustedFiles(
    layout.anchor,
    layout.ownerUid,
    layout.acl,
    `${layout.appRelative}/config`,
  );
  const bytes = await configFiles.read(CANDIDATE_CONFIG_FILE, 262_144);
  const config = parseConfig(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
  );
  const releaseFiles = createTrustedFiles(
    layout.anchor,
    layout.ownerUid,
    layout.acl,
    `${layout.appRelative}/releases/${config.releaseId}`,
  );
  const evidence = await inspectRelease(config, config.releaseDigest, releaseFiles);
  if (evidence.verified !== true || evidence.digest !== config.releaseDigest) {
    throw new Error('UNTRUSTED_RELEASE');
  }
  return parseConfig(config);
}

export function readSystemCandidateConfig(acl: AclProbe): Promise<ServiceConfig> {
  return readCandidateConfigAt({
    anchor: '/',
    ownerUid: 0,
    appRelative: root.slice(1),
    acl,
  });
}

export function readSystemCandidateConfigMetadata(acl: AclProbe): Promise<ServiceConfig> {
  return readCandidateConfigMetadataAt({
    anchor: '/',
    ownerUid: 0,
    appRelative: root.slice(1),
    acl,
  });
}
