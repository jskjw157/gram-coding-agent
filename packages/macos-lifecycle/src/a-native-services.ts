import { execFile } from 'node:child_process';
import type { Role } from './contracts.js';
import type { InstallResult, ServiceHandle } from './installation-transaction/contracts.js';
import {
  createLaunchctlServices,
  launchctlVector,
  LAUNCHCTL_BIN,
  type LaunchctlObservation,
  type LaunchctlRunner,
} from './adapters/launchctl.js';
import { inspectMacRegistry } from './adapters/macos-service-probes.js';
import type { AclProbe } from './adapters/trusted-files.js';
import { createInstalledHealthObserver } from './a-native-observer.js';
import { abortable } from './health-probe.js';
import { INSTALLED_HEALTH_TIMEOUT_MS } from './release-review-budget.js';

const MAX_OUTPUT = 1024 * 1024;

export function createSystemLaunchctlRunner(): LaunchctlRunner {
  return async (argv: readonly string[]): Promise<LaunchctlObservation> => {
    try {
      if (!Array.isArray(argv) || argv.length < 3 || argv.length > 4
        || argv[0] !== LAUNCHCTL_BIN
        || argv.some(value => typeof value !== 'string' || value.length === 0 || value.length > 4096)) {
        return { code: 255, stdout: '', stderr: '' };
      }
      const fixedBootout = (['core', 'tunnel'] as const).some(role => {
        const expected = launchctlVector('bootout', role);
        return argv.length === expected.length && expected.every((value, index) => argv[index] === value);
      });
      return await new Promise(resolve => {
        execFile(
          LAUNCHCTL_BIN,
          [...argv.slice(1)],
          {
            encoding: 'utf8',
            // Fixed jobs render ExitTimeOut=30 in launchd-plist.ts. Allow that
            // stop window only for their exact bootout vectors.
            timeout: fixedBootout ? 30_000 : 5_000,
            killSignal: 'SIGKILL',
            maxBuffer: MAX_OUTPUT,
            shell: false,
            env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C', LANG: 'C' },
          },
          (error, stdout, stderr) => {
            const rawCode = error?.code;
            const code = error === null ? 0
              : error?.killed !== true && error?.signal == null && typeof rawCode === 'number'
                && Number.isSafeInteger(rawCode) && rawCode >= 1 && rawCode <= 255 ? rawCode : 255;
            resolve({
              code,
              stdout: typeof stdout === 'string' ? stdout : '',
              stderr: typeof stderr === 'string' ? stderr : '',
            });
          },
        );
      });
    } catch {
      return { code: 255, stdout: '', stderr: '' };
    }
  };
}

async function boundedHealth(
  role: Role,
  observer: ReturnType<typeof createInstalledHealthObserver>,
): Promise<boolean> {
  const deadline = Date.now() + INSTALLED_HEALTH_TIMEOUT_MS;
  do {
    const controller = new AbortController();
    // Allow runtime preparation, Core startup and the final sealed review.
    // Every retry shares the same overall deadline, including its backoff.
    const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
    try {
      if (await abortable(observer.healthy(role, controller.signal), controller.signal) === true
        && Date.now() < deadline) return true;
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(200, deadline - Date.now())));
  } while (Date.now() < deadline);
  return false;
}

/**
 * Native fixed-label service handle for installer/local-control.
 * No arbitrary command/label input, no shell, no credential values.
 * Health is not inferred from launchd presence: it is independently tied to
 * reviewed execution/registration/native process identity + fresh supervisor
 * telemetry.
 */
export function createSystemServiceHandle(acl: AclProbe): ServiceHandle {
  const launchctl = createLaunchctlServices(createSystemLaunchctlRunner());
  const observer = createInstalledHealthObserver(acl);

  return Object.freeze({
    async stop(role: Role): Promise<InstallResult> {
      return await launchctl.stop(role);
    },
    async start(role: Role): Promise<InstallResult> {
      return await launchctl.start(role);
    },
    async isStopped(role: Role): Promise<boolean> {
      return await launchctl.inspect(role) === 'absent';
    },
    async ownedHealthy(role: Role): Promise<boolean> {
      return await boundedHealth(role, observer);
    },
  });
}


/**
 * macOS has no per-label "delete disabled override" primitive. Measured on
 * hosted macOS: `launchctl enable system/<label>` leaves an explicit
 * enabled/false override. Normalize a stopped/absent fixed service to that
 * inert state before removing its plist, then verify both job absence and the
 * exact enabled override. No bootstrap or arbitrary label is possible here.
 */
export async function normalizeAbsentSystemServiceOverride(role: Role): Promise<InstallResult> {
  try {
    const runner = createSystemLaunchctlRunner();
    const services = createLaunchctlServices(runner);
    if (await services.inspect(role) !== 'absent') return { ok: false, code: 'PARTIAL_INSTALL' };

    const result = await runner(launchctlVector('enable', role));
    if (result.code !== 0) {
      if (/permission|not authorized|operation not permitted/i.test(result.stderr)) {
        return { ok: false, code: 'NOT_AUTHORIZED' };
      }
      return { ok: false, code: 'PARTIAL_INSTALL' };
    }

    const registry = await inspectMacRegistry();
    if (registry === null
      || registry.jobs[role] !== 'absent'
      || registry.overrides[role] !== false) {
      return { ok: false, code: 'PARTIAL_INSTALL' };
    }
    return { ok: true, code: 'OK' };
  } catch {
    return { ok: false, code: 'PARTIAL_INSTALL' };
  }
}
