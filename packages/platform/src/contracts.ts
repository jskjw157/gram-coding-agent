export interface HostFacts {
  platform: string;
  arch: string;
  release: string;
  nodeVersion: string;
}
export interface PlatformDetection {
  kind: 'macos-arm64' | 'linux-wsl' | 'unsupported';
  compatible: boolean;
  reason: 'SUPPORTED_TARGET' | 'NODE_24_REQUIRED' | 'MACOS_ARM64_REQUIRED' | 'UNSUPPORTED_PLATFORM';
}
export const probeKeys = [
  'CORE', 'ISOLATION', 'SERVICE_AUTH', 'GUI_SESSION', 'USER_VAULT',
  'ASIDE', 'ASIDE_ACCOUNT', 'PLAYWRIGHT', 'PLAYWRIGHT_ACCOUNT', 'SCREEN_RECORDING',
] as const;
export type ProbeKey = (typeof probeKeys)[number];
export interface Observation {
  state: 'READY' | 'BLOCKED' | 'UNKNOWN';
  observedAtMs: number;
  contextId: string;
}
export interface ReadinessSnapshot {
  host: PlatformDetection;
  contextId: string;
  probes: Partial<Record<ProbeKey, Observation>>;
}
export type WorkRequest =
  | { kind: 'API_READ'; auth: 'NONE' | 'SERVICE' | 'USER' }
  | { kind: 'BROWSER_READ'; provider: 'ASIDE' | 'PLAYWRIGHT' }
  | { kind: 'SCREEN_CAPTURE' };
export type BlockerReason =
  | 'UNSUPPORTED_HOST' | 'INVALID_REQUEST' | 'INVALID_CLOCK' | 'INVALID_CONTEXT'
  | 'MISSING' | 'CONTEXT_CHANGED' | 'INVALID_TIME' | 'FUTURE' | 'STALE' | 'BLOCKED' | 'UNKNOWN';
export interface Blocker { probe: ProbeKey | 'HOST' | 'REQUEST' | 'CLOCK' | 'CONTEXT'; reason: BlockerReason }
export interface ReadinessResult {
  status: 'READY' | 'BLOCKED' | 'UNKNOWN' | 'UNSUPPORTED';
  blockers: Blocker[];
}
