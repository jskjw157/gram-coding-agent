import type { Role, SafeCode } from '../contracts.js';

/** MAC-02 Task 6 transaction ports. All operations are narrow and fixed;
 * no arbitrary command, path, label, or secret input is accepted here.
 * Production wiring (Task 7 / integrator A) supplies trusted adapters;
 * tests supply byte-level fixtures. Nothing here performs OS authorization
 * or process control by itself.
 */
export type InstallStage =
  | 'PREPARED' | 'STOPPED' | 'FILES_STAGED' | 'PUBLISHED' | 'STARTED' | 'COMMITTED';

export type ControlAction = 'start' | 'stop' | 'restart' | 'reset-failure' | 'uninstall';

export interface InstallResult {
  ok: boolean;
  code: SafeCode;
  stage?: InstallStage;
}

export interface PriorInstall {
  digest: string | null;
  manifest: Buffer | null;
  config: Buffer | null;
  corePlist: Buffer | null;
  tunnelPlist: Buffer | null;
  enabled: Record<Role, boolean>;
  present: Record<Role, boolean>;
  releaseId: string | null;
  releaseDigest: string | null;
}

export interface Revalidation {
  ok: boolean;
  code: SafeCode;
  previewToken: string;
  priorDigest: string | null;
  releaseId: string;
  releaseDigest: string;
  runtime: { name: 'gram-agent'; uid: number; gid: number };
}

export interface LockSession {
  acquired: boolean;
  release(): Promise<void>;
}

export interface JournalPort {
  read(): Promise<Buffer | null>;
  writeStage(stage: InstallStage, body: Buffer): Promise<void>;
}

export type PublishKind = 'configuration' | 'core' | 'tunnel' | 'manifest' | 'journal';

export interface PublishPort {
  stageFile(kind: PublishKind, bytes: Buffer): Promise<void>;
  publishFile(kind: PublishKind, bytes: Buffer): Promise<void>;
  readStaged(kind: PublishKind): Promise<Buffer | null>;
  readLive(kind: PublishKind): Promise<Buffer | null>;
}

export interface RestorePort {
  restorePrior(prior: PriorInstall): Promise<void>;
  removeManifestOwned(kind: 'core' | 'tunnel', expectedBytes: Buffer): Promise<boolean>;
  resetExecutionRecords(): Promise<InstallResult>;
  ensureExecutionAbsentOnly(isNewInstall: boolean): Promise<InstallResult>;
}

export interface ServiceHandle {
  stop(role: Role): Promise<InstallResult>;
  start(role: Role): Promise<InstallResult>;
  isStopped(role: Role): Promise<boolean>;
  ownedHealthy(role: Role): Promise<boolean>;
}

export type ClosedSchemaState = 'absent' | 'present' | 'unreadable' | 'corrupt';

export interface ClosedSchemaReading {
  state: ClosedSchemaState;
  versions: number[] | null;
  raw: Buffer | null;
}

export interface InstallPorts {
  authorizeLocalAdmin(): Promise<boolean>;
  lock(): Promise<LockSession>;
  revalidate(): Promise<Revalidation>;
  readPrior(): Promise<PriorInstall>;
  journal(): JournalPort;
  publish(): PublishPort;
  restore(): RestorePort;
  services(): ServiceHandle;
  readClosedSchema(): Promise<ClosedSchemaReading>;
  trustedAcceptedSets(): Promise<readonly (readonly number[])[] | null>;
}

export function isControlAction(value: unknown): value is ControlAction {
  return value === 'start' || value === 'stop' || value === 'restart'
    || value === 'reset-failure' || value === 'uninstall';
}

export function isInstallStage(value: unknown): value is InstallStage {
  return value === 'PREPARED' || value === 'STOPPED' || value === 'FILES_STAGED'
    || value === 'PUBLISHED' || value === 'STARTED' || value === 'COMMITTED';
}
