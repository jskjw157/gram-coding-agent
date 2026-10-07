import { labels, type Role } from '../contracts.js';
import type { InstallResult } from '../installation-transaction/contracts.js';

/** Fixed launchctl adapter. Only exact /bin/launchctl vectors for fixed
 * system labels are produced. Never uses killall, PID scraping, arbitrary
 * user arguments, or broad cleanup. Distinguishes absent jobs from
 * permission/parse/OS errors; nonzero output is not automatically
 * "already stopped".
 */
export const LAUNCHCTL_BIN = '/bin/launchctl';
const TERMINATION_TIMEOUT_MS = 30_000;
const ABSENCE_POLL_INTERVAL_MS = 200;

export type LaunchctlAction = 'bootstrap' | 'bootout' | 'enable' | 'disable' | 'print';

export interface LaunchctlObservation {
  code: number;
  stdout: string;
  stderr: string;
}

export type LaunchctlRunner = (
  argv: readonly string[],
) => Promise<LaunchctlObservation>;

function roleLabel(role: Role): string {
  if (role !== 'core' && role !== 'tunnel') throw new Error('INVALID_CONFIG');
  return labels[role];
}

/** Exact vectors. bootstrap/enable take a fixed system domain + label;
 * bootout/disable/print take the same fixed label. No caller input flows in.
 */
export function launchctlVector(action: LaunchctlAction, role: Role): readonly string[] {
  const label = roleLabel(role);
  switch (action) {
    case 'bootstrap':
      return Object.freeze([LAUNCHCTL_BIN, 'bootstrap', 'system', `/Library/LaunchDaemons/${label}.plist`]);
    case 'bootout':
      return Object.freeze([LAUNCHCTL_BIN, 'bootout', `system/${label}`]);
    case 'enable':
      return Object.freeze([LAUNCHCTL_BIN, 'enable', `system/${label}`]);
    case 'disable':
      return Object.freeze([LAUNCHCTL_BIN, 'disable', `system/${label}`]);
    case 'print':
      return Object.freeze([LAUNCHCTL_BIN, 'print', `system/${label}`]);
    default:
      throw new Error('INVALID_CONFIG');
  }
}

function isObservation(value: unknown): value is LaunchctlObservation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  return typeof o.code === 'number' && Number.isSafeInteger(o.code)
    && typeof o.stdout === 'string' && typeof o.stderr === 'string';
}

function absentPrint(role: Role, obs: LaunchctlObservation): boolean {
  const missing = `Could not find service "${roleLabel(role)}" in domain for system\n`;
  return obs.code === 113 && obs.stdout === ''
    && (obs.stderr === missing || obs.stderr === `Bad request.\n${missing}`);
}

function presentPrint(role: Role, obs: LaunchctlObservation): boolean {
  return obs.code === 0 && obs.stderr === ''
    && obs.stdout.startsWith(`system/${roleLabel(role)} = {\n`)
    && obs.stdout.endsWith('}\n');
}

export type JobState = 'absent' | 'present' | 'permission-error' | 'parse-error' | 'os-error';

export function parsePrintState(role: Role, value: unknown): JobState {
  if (!isObservation(value)) return 'parse-error';
  if (absentPrint(role, value)) return 'absent';
  if (presentPrint(role, value)) return 'present';
  if (value.code === 1 && /permission|not authorized|operation not permitted/i.test(value.stderr)) {
    return 'permission-error';
  }
  if (value.code !== 0) return 'os-error';
  return 'parse-error';
}

export interface LaunchctlServices {
  stop(role: Role): Promise<InstallResult>;
  start(role: Role): Promise<InstallResult>;
  inspect(role: Role): Promise<JobState>;
}

/** Stop disables before bootout and verifies absence. Restart restores the
 * intended enabled state via the caller (local-control), not here.
 */
export function createLaunchctlServices(runner: LaunchctlRunner): LaunchctlServices {
  const run = async (action: LaunchctlAction, role: Role): Promise<LaunchctlObservation> => {
    const argv = launchctlVector(action, role);
    if (argv[0] !== LAUNCHCTL_BIN) throw new Error('INTERNAL_ERROR');
    const result = await runner(argv);
    if (!isObservation(result)) throw new Error('INTERNAL_ERROR');
    return result;
  };
  const stopDisabled = async (role: Role): Promise<InstallResult> => {
    // A clean bootout acknowledgement can precede launchd removing the job.
    // Bootout, every observation and every pause share this one stop window.
    const deadline = performance.now() + TERMINATION_TIMEOUT_MS;
    let expired = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>(resolve => {
      deadlineTimer = setTimeout(() => { expired = true; resolve(null); }, TERMINATION_TIMEOUT_MS);
    });
    const runBeforeDeadline = async (action: 'bootout' | 'print'): Promise<LaunchctlObservation | null> => {
      if (expired || performance.now() >= deadline) return null;
      // The runner contract has no cancellation port. Race even a runner that
      // never settles, then reject late output before accepting any evidence.
      const result = await Promise.race([run(action, role), timeout]);
      return !expired && performance.now() < deadline ? result : null;
    };
    try {
      const bootout = await runBeforeDeadline('bootout');
      if (bootout === null) return { ok: false, code: 'PARTIAL_INSTALL' };
      for (;;) {
        const observation = await runBeforeDeadline('print');
        if (observation === null) return { ok: false, code: 'PARTIAL_INSTALL' };
        const after = parsePrintState(role, observation);
        if (after === 'absent') return { ok: true, code: 'OK' };
        if (after === 'permission-error') return { ok: false, code: 'NOT_AUTHORIZED' };
        if (bootout.code !== 0 || after !== 'present') return { ok: false, code: 'PARTIAL_INSTALL' };
        const remaining = deadline - performance.now();
        if (expired || remaining <= 0) return { ok: false, code: 'PARTIAL_INSTALL' };
        await Promise.race([
          new Promise<void>(resolve => { pollTimer = setTimeout(resolve, Math.min(ABSENCE_POLL_INTERVAL_MS, remaining)); }),
          timeout,
        ]);
      }
    } finally {
      clearTimeout(deadlineTimer);
      clearTimeout(pollTimer);
    }
  };
  return Object.freeze({
    async inspect(role: Role): Promise<JobState> {
      try {
        return parsePrintState(role, await run('print', role));
      } catch {
        return 'os-error';
      }
    },
    async stop(role: Role): Promise<InstallResult> {
      try {
        const before = parsePrintState(role, await run('print', role));
        if (before === 'absent') return { ok: true, code: 'OK' };
        if (before === 'permission-error') return { ok: false, code: 'NOT_AUTHORIZED' };
        if (before === 'parse-error') return { ok: false, code: 'FOREIGN_SERVICE' };
        if (before === 'os-error') return { ok: false, code: 'PARTIAL_INSTALL' };
        const disable = await run('disable', role);
        if (disable.code !== 0) {
          if (/permission|not authorized|operation not permitted/i.test(disable.stderr)) {
            return { ok: false, code: 'NOT_AUTHORIZED' };
          }
          return { ok: false, code: 'PARTIAL_INSTALL' };
        }
        return await stopDisabled(role);
      } catch {
        return { ok: false, code: 'INTERNAL_ERROR' };
      }
    },
    async start(role: Role): Promise<InstallResult> {
      try {
        const enable = await run('enable', role);
        if (enable.code !== 0) {
          if (/permission|not authorized|operation not permitted/i.test(enable.stderr)) {
            return { ok: false, code: 'NOT_AUTHORIZED' };
          }
          return { ok: false, code: 'PARTIAL_INSTALL' };
        }
        const bootstrap = await run('bootstrap', role);
        if (bootstrap.code !== 0) return { ok: false, code: 'PARTIAL_INSTALL' };
        return { ok: true, code: 'OK' };
      } catch {
        return { ok: false, code: 'INTERNAL_ERROR' };
      }
    },
  });
}
