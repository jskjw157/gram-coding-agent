import type { Preview, Result, ServiceConfig } from './contracts.js';
import { parseConfig } from './config.js';
import type {
  CliDeps,
  DiagnosticEvidence,
  ExpectedInstallRequest,
  LocalControlAction,
  RollbackRequest,
} from './cli-contracts.js';
import { apply } from './install-service.js';
import { control } from './local-control.js';
import { rollbackToReviewedTarget } from './rollback-service.js';
import type { RollbackPorts } from './rollback-contracts.js';
import type {
  InstallPorts,
  InstallResult,
  ServiceHandle,
} from './installation-transaction/contracts.js';
import type { LocalControlPorts, LocalControlRestorePort } from './installation-transaction/control-contracts.js';
import type { ReviewedServiceRuntime } from './adapters/runtime-authority.js';

function fail(code: Result['code']): Result {
  return { ok: false, code };
}

function resultOf(result: InstallResult): Result {
  if (result.ok === true && result.code === 'OK') return { ok: true, code: 'OK' };
  if (result.ok === false && result.code !== 'OK') return { ok: false, code: result.code };
  return { ok: false, code: 'INTERNAL_ERROR' };
}

function matchesExpected(preview: Preview, request: ExpectedInstallRequest): boolean {
  return preview.ok === true
    && preview.code === 'OK'
    && preview.configDigest === request.expectedPreviewDigest
    && preview.previousInstallDigest === request.expectedInstallDigest;
}

export interface ReviewedInstallerCliOptions {
  readonly config: ServiceConfig;
  preview(): Promise<Preview>;
  diagnostic(): Promise<DiagnosticEvidence>;
  readonly installPorts: InstallPorts;
  readonly rollbackPorts: RollbackPorts;
  readonly output: CliDeps['output'];
}

/**
 * A/WP-06 composition: bind the reviewed CLI to the repaired installer lanes.
 *
 * The caller still owns native authorization and evidence ports. This function
 * never elevates privilege, loads launchd, reads credentials, or invents a
 * native success. It only enforces the preview/install identity before routing:
 * - apply -> B1 apply
 * - rollback -> B2 retained reviewed-target rollback (never legacy rollback)
 * - local control -> B3 control
 * - status -> D diagnostic evidence
 */
export function createReviewedInstallerCliDeps(options: ReviewedInstallerCliOptions): CliDeps {
  const config = parseConfig(options.config);
  Object.freeze(config.tunnel);
  Object.freeze(config);
  const getPreview = options.preview.bind(options);
  const getDiagnostic = options.diagnostic.bind(options);
  const installPorts = options.installPorts;
  const rollbackPorts = options.rollbackPorts;

  const expected = async (request: ExpectedInstallRequest): Promise<Preview | null> => {
    const current = await getPreview();
    return matchesExpected(current, request) && current.releaseDigest === config.releaseDigest
      ? current
      : null;
  };

  return Object.freeze({
    preview: getPreview,
    status: getDiagnostic,
    async apply(request: ExpectedInstallRequest): Promise<Result> {
      const reviewed = await expected(request);
      if (reviewed === null) return fail('CONFIG_CHANGED');
      return resultOf(await apply(reviewed, config, installPorts));
    },
    async rollback(request: RollbackRequest): Promise<Result> {
      if (await expected(request) === null) return fail('CONFIG_CHANGED');
      return resultOf(await rollbackToReviewedTarget(request.targetReleaseDigest, rollbackPorts));
    },
    async control(action: LocalControlAction, request: ExpectedInstallRequest): Promise<Result> {
      if (await expected(request) === null) return fail('CONFIG_CHANGED');
      return resultOf(await control(action, installPorts));
    },
    output: options.output,
  });
}

export interface StoppedFailureResetOptions {
  readonly runtime: Pick<ReviewedServiceRuntime, 'stores' | 'proveStopped'>;
  readonly services: Pick<ServiceHandle, 'isStopped'>;
  readonly clock?: () => number;
}

/**
 * A-owned narrow reset capability consumed by B3 local-control.
 *
 * This is deliberately separate from ExecutionLeaseStore recovery/reset.
 * It only clears LifecycleStore restart-budget failure state after both jobs
 * are independently confirmed stopped. It preserves execution HELD/revision,
 * installation bytes, database bytes, and journal identity because it has no
 * access to those stores.
 */
export function createReviewedStoppedFailureReset(
  base: LocalControlRestorePort,
  options: StoppedFailureResetOptions,
): LocalControlRestorePort {
  const clock = options.clock ?? Date.now;
  const lifecycle = options.runtime.stores.lifecycle;
  const services = options.services;

  return Object.freeze({
    ...base,
    async resetStoppedFailure(): Promise<InstallResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      try {
        if (await services.isStopped('tunnel') !== true
          || await services.isStopped('core') !== true
          || await options.runtime.proveStopped('core', controller.signal) !== true
          || controller.signal.aborted) {
          return { ok: false, code: 'PARTIAL_INSTALL' };
        }

        const before = await lifecycle.read('core');
        const generation = before.history.lastGeneration;
        const nowMs = clock();
        if (before.history.activeAttempt !== null
          || generation === null
          || !Number.isSafeInteger(nowMs)
          || nowMs < before.history.lastSeenMs) {
          return { ok: false, code: 'PARTIAL_INSTALL' };
        }

        const after = await lifecycle.write('core', before, {
          kind: 'reset',
          generation,
          nowMs,
        });
        if (after.history.blocked !== false
          || after.history.activeAttempt !== null
          || after.history.lastGeneration !== generation
          || after.history.exitsMs.length !== 0) {
          return { ok: false, code: 'PARTIAL_INSTALL' };
        }
        return { ok: true, code: 'OK' };
      } catch {
        return { ok: false, code: 'PARTIAL_INSTALL' };
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    },
  });
}


/**
 * Bind the B3 control surface to the A-owned reviewed LifecycleStore reset.
 * Every other installer capability is delegated unchanged; only restore()
 * gains the narrow resetStoppedFailure capability.
 */
export function createReviewedLocalControlPorts(
  ports: InstallPorts,
  runtime: Pick<ReviewedServiceRuntime, 'stores' | 'proveStopped'>,
  clock?: () => number,
): LocalControlPorts {
  return Object.freeze({
    ...ports,
    restore(): LocalControlRestorePort {
      const services = ports.services();
      return createReviewedStoppedFailureReset(ports.restore(), {
        runtime,
        services,
        ...(clock === undefined ? {} : { clock }),
      });
    },
  });
}
