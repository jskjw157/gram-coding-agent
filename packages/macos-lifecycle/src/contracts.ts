export type Role = 'core' | 'tunnel';
export const labels = Object.freeze({
  core: 'com.haar.gram-agent.core',
  tunnel: 'com.haar.gram-agent.tunnel',
} as const);
export const root = '/Library/Application Support/HAAR/GramAgent';
export interface ServiceConfig {
  schemaVersion: 1;
  mode: 'LAB_ONLY';
  runtimeUser: 'gram-agent';
  releaseId: string;
  releaseDigest: string;
  tunnel: { enabled: false } | {
    enabled: true;
    compatibilityDigest: string;
    credentialRef: 'test-tunnel-key';
  };
}
export interface AccountIdentity {
  uid: number; gid: number; admin: boolean; name: 'gram-agent';
}
export interface OwnedChild {
  role: Role; pid: number; startIdentity: string;
  generation: string; releaseDigest: string; uid: number;
}
export type SafeCode =
  | 'OK' | 'UNSUPPORTED_HOST' | 'INVALID_CONFIG' | 'ACCOUNT_INVALID'
  | 'UNTRUSTED_RELEASE' | 'UNSAFE_PATH' | 'FOREIGN_SERVICE' | 'PORT_IN_USE'
  | 'CONFIG_CHANGED' | 'BUSY' | 'AUTH_BLOCKED' | 'HEALTH_UNKNOWN'
  | 'TOOL_SURFACE_MISMATCH' | 'RESTART_BUDGET' | 'INVALID_HISTORY'
  | 'ROLLBACK_BLOCKED_SCHEMA' | 'PARTIAL_INSTALL' | 'NOT_AUTHORIZED'
  | 'TUNNEL_COMPATIBILITY_REQUIRED' | 'INTERNAL_ERROR';
export interface Result { ok: boolean; code: SafeCode }
export interface Preview {
  ok: boolean; code: SafeCode;
  configDigest: string; previousInstallDigest: string | null;
  releaseDigest: string; roles: Role[];
}
export interface Clock {
  nowMs(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}
