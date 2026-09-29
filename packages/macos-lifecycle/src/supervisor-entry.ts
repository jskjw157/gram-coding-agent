import { root, type Role } from './contracts.js';
import { abortable } from './health-probe.js';
import type { ServiceSession } from './service-session.js';
export interface SupervisorInvocation { role: Role; configPath: string }
/** Trusted local bootstrap. prepare must not spawn, mutate or retain resources.
 * It supplies independently established trust, not modules named by argv/env.
 */
export interface SupervisorBootstrap {
  prepare(invocation: Readonly<SupervisorInvocation>, signal: AbortSignal): Promise<ServiceSession | null>;
}
export interface SupervisorSignals {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  removeListener(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}
const CONFIG_PATH = `${root}/config/service.json`;
function invalid(): never { throw new Error('INVALID_SUPERVISOR_ARGUMENTS'); }
/** Internal launchd grammar only. Public CLI routing belongs to a separate lane. */
export function parseSupervisorInvocation(argv: readonly string[]): Readonly<SupervisorInvocation> {
  try {
    if (!Array.isArray(argv) || Object.getPrototypeOf(argv) !== Array.prototype || argv.length !== 4
      || Reflect.ownKeys(argv).length !== 5) invalid();
    const copy: string[] = [];
    for (let i = 0; i < 4; i++) {
      const d = Object.getOwnPropertyDescriptor(argv, String(i));
      if (!d || !d.enumerable || !('value' in d) || typeof d.value !== 'string' || d.value.length > 4096) invalid();
      copy.push(d.value);
    }
    let role: Role | undefined; let configuration: string | undefined;
    for (let i = 0; i < 4; i += 2) {
      const flag = copy[i]; const value = copy[i + 1];
      if (flag === '--role' && role === undefined && (value === 'core' || value === 'tunnel')) role = value;
      else if (flag === '--config' && configuration === undefined && value === CONFIG_PATH) configuration = value;
      else invalid();
    }
    if (!role || configuration !== CONFIG_PATH) invalid();
    return Object.freeze({ role, configPath: CONFIG_PATH });
  } catch { return invalid(); }
}

/** No import-time effects, process.exit, raw output, credential flags or native
 * bootstrap fallback. 0 means terminated normally, not ready for business work.
 * A running session is awaited on cancellation so child shutdown is not skipped.
 */
export async function runSupervisorEntry(argv: readonly string[], bootstrap?: SupervisorBootstrap,
  signals: SupervisorSignals = process): Promise<number> {
  let invocation: Readonly<SupervisorInvocation>;
  try { invocation = parseSupervisorInvocation(argv); } catch { return 64; }
  let prepare: SupervisorBootstrap['prepare'];
  try { if (!bootstrap || typeof bootstrap.prepare !== 'function') return 78; prepare = bootstrap.prepare.bind(bootstrap); }
  catch { return 78; }
  const controller = new AbortController(); const stop = () => controller.abort();
  let result = 70;
  async function execute(): Promise<number> {
    signals.on('SIGINT', stop); signals.on('SIGTERM', stop);
    if (controller.signal.aborted) return 0;
    const deadline = new AbortController(); let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; deadline.abort(); }, 10000);
    const signal = AbortSignal.any([controller.signal, deadline.signal]);
    let session: ServiceSession | null;
    try { session = await abortable(Promise.resolve(prepare(invocation, signal)), signal); }
    catch { return controller.signal.aborted ? 0 : timedOut ? 78 : 70; }
    finally { clearTimeout(timer); deadline.abort(); }
    if (controller.signal.aborted) return 0;
    if (session === null) return 78;
    if (!session || typeof session.run !== 'function') return 70;
    const exit = await session.run(controller.signal);
    return exit === 0 || exit === 1 ? exit : 70;
  }
  try { result = await execute(); } catch { result = 70; }
  finally {
    controller.abort();
    for (const event of ['SIGINT', 'SIGTERM'] as const) {
      try { signals.removeListener(event, stop); } catch { result = 70; }
    }
  }
  return result;
}
