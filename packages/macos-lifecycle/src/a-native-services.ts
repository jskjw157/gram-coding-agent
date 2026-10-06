import { execFile } from 'node:child_process';
import type { Role } from './contracts.js';
import type { InstallResult, ServiceHandle } from './installation-transaction/contracts.js';
import {
  createLaunchctlServices,
  LAUNCHCTL_BIN,
  type LaunchctlObservation,
  type LaunchctlRunner,
} from './adapters/launchctl.js';
import type { AclProbe } from './adapters/trusted-files.js';
import { createInstalledHealthObserver } from './a-native-observer.js';

const MAX_OUTPUT = 1024 * 1024;

export function createSystemLaunchctlRunner(): LaunchctlRunner {
  return async (argv: readonly string[]): Promise<LaunchctlObservation> => {
    try {
      if (!Array.isArray(argv) || argv.length < 3 || argv.length > 4
        || argv[0] !== LAUNCHCTL_BIN
        || argv.some(value => typeof value !== 'string' || value.length === 0 || value.length > 4096)) {
        return { code: 255, stdout: '', stderr: '' };
      }
      return await new Promise(resolve => {
        execFile(
          LAUNCHCTL_BIN,
          [...argv.slice(1)],
          {
            encoding: 'utf8',
            timeout: 5_000,
            killSignal: 'SIGKILL',
            maxBuffer: MAX_OUTPUT,
            shell: false,
            env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C', LANG: 'C' },
          },
          (error, stdout, stderr) => {
            const rawCode = error && typeof error.code === 'number' ? error.code : 0;
            const code = Number.isSafeInteger(rawCode) && rawCode >= 0 && rawCode <= 255
              ? rawCode
              : 255;
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
  const deadline = Date.now() + 60_000;
  do {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_500);
    try {
      if (await observer.healthy(role, controller.signal) === true) return true;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 200));
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
