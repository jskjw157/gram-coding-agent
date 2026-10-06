import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runSupervisorEntry, type SupervisorBootstrap, type SupervisorSignals } from './supervisor-entry.js';
import { createASystemSupervisorBootstrapFromFixedSources } from './a-bootstrap.js';

/** Pure direct-entry test. Importing this module never starts a service. */
export function isDirectSupervisorCli(moduleUrl: string, argv1: string | undefined): boolean {
  try {
    if (typeof argv1 !== 'string' || !isAbsolute(argv1)) return false;
    const parsed = new URL(moduleUrl);
    return parsed.protocol === 'file:' && pathToFileURL(argv1).href === parsed.href;
  } catch {
    return false;
  }
}

/** Internal launchd entry only. No public lifecycle commands or provider data
 * are accepted here. Without an independently supplied bootstrap it fails
 * closed with EX_CONFIG (78) through the existing supervisor entry contract.
 */
export async function runSupervisorCli(
  argv: readonly string[],
  bootstrap?: SupervisorBootstrap,
  signals: SupervisorSignals = process,
): Promise<number> {
  return runSupervisorEntry(argv, bootstrap, signals);
}

if (isDirectSupervisorCli(import.meta.url, process.argv[1])) {
  let bootstrap: SupervisorBootstrap | undefined;
  try {
    bootstrap = createASystemSupervisorBootstrapFromFixedSources();
  } catch {
    bootstrap = undefined;
  }
  void runSupervisorCli(process.argv.slice(2), bootstrap).then(
    code => { process.exitCode = code; },
    () => { process.exitCode = 70; },
  );
}
