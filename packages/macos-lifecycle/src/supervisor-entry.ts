import type { Role } from './contracts.js';
import type { ServiceSession } from './service-session.js';
export interface SupervisorInvocation { role: Role; configPath: string }
export interface SupervisorBootstrap {
  prepare(invocation: Readonly<SupervisorInvocation>, signal: AbortSignal): Promise<ServiceSession | null>;
}
export interface SupervisorSignals {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  removeListener(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}
/** Internal launchd grammar, not the public management CLI. */
export function parseSupervisorInvocation(_argv: readonly string[]): Readonly<SupervisorInvocation> {
  throw new Error('NOT_IMPLEMENTED');
}
export async function runSupervisorEntry(_argv: readonly string[], _bootstrap?: SupervisorBootstrap,
  _signals?: SupervisorSignals): Promise<number> { throw new Error('NOT_IMPLEMENTED'); }
