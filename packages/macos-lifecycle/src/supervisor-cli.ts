import { pathToFileURL } from 'node:url';
import type { SupervisorBootstrap, SupervisorSignals } from './supervisor-entry.js';

export function isDirectSupervisorCli(_moduleUrl: string, _argv1: string | undefined): boolean {
  void pathToFileURL;
  return false;
}

export async function runSupervisorCli(
  _argv: readonly string[],
  _bootstrap?: SupervisorBootstrap,
  _signals?: SupervisorSignals,
): Promise<number> {
  throw new Error('NOT_IMPLEMENTED');
}
