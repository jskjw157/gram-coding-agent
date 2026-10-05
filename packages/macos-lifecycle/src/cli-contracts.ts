import type { Preview, Result, SafeCode } from './contracts.js';
import type { ServiceState, StatusIdentity } from './telemetry.js';

export interface PublicRoleStatus {
  state: ServiceState; code: SafeCode; generation: string | null;
  releaseDigest: string | null; ageMs: number | null;
}
export interface LifecycleReport {
  schemaVersion: 1; mode: 'LAB_ONLY'; core: PublicRoleStatus; tunnel: PublicRoleStatus;
  businessReadiness: 'UNAVAILABLE';
}
/** INTERNAL evidence port only. Native A composition establishes the context;
 * JSON/PID/status syntax never grants ownership or authenticated health.
 * Null means that the source cannot independently establish that context.
 */
export interface RoleObservation { status: unknown; currentIdentity: StatusIdentity | null }
export interface DiagnosticEvidence { nowMs: number; core: RoleObservation; tunnel: RoleObservation }
export interface CliPreviewReport {
  schemaVersion: 1; mode: 'LAB_ONLY'; action: 'preview';
  businessReadiness: 'UNAVAILABLE'; preview: Preview;
}
export interface ExpectedInstallRequest {
  config: 'service'; expectedPreviewDigest: string; expectedInstallDigest: string | null;
}
export interface RollbackRequest extends ExpectedInstallRequest { targetReleaseDigest: string }
export type LocalControlAction = 'start' | 'stop' | 'restart' | 'reset-failure' | 'uninstall';
export type MutationAction = 'apply' | 'rollback' | LocalControlAction;
export type CliCode = SafeCode | 'INVALID_USAGE' | 'CAPABILITY_UNAVAILABLE';
export interface CliResultReport {
  schemaVersion: 1; mode: 'LAB_ONLY'; action: MutationAction | 'preview' | 'status' | null;
  businessReadiness: 'UNAVAILABLE'; result: { ok: boolean; code: CliCode };
}
/** Narrow local ports. Flags are expected-state inputs, never OS authorization.
 * No credentials, shell execution or native side effects during construction.
 * A maps installer results and verified native observations to these ports.
 */
export interface CliDeps {
  preview?(): Promise<Preview>;
  status?(): Promise<DiagnosticEvidence>;
  apply?(request: ExpectedInstallRequest): Promise<Result>;
  rollback?(request: RollbackRequest): Promise<Result>;
  control?(action: LocalControlAction, request: ExpectedInstallRequest): Promise<Result>;
  output(jsonLine: string): void | Promise<void>;
}
