import type { Preview, Result, ServiceConfig } from './contracts.js';
import type { CliDeps, ExpectedInstallRequest, LocalControlAction } from './cli-contracts.js';
import { preview, reviewToken } from './preflight.js';
import { createMacInspector, installPaths } from './adapters/native-inspector.js';
import { createInstalledRuntimeReviewSource, createSystemBootstrapAclProbe } from './a-system-sources.js';
import { readSystemCandidateConfig } from './a-candidate-config.js';
import { createSystemNativeInstallPorts, createSystemNativeRunningControlPorts } from './a-native-install.js';
import { createSystemDiagnosticEvidence } from './a-native-diagnostic.js';
import { apply } from './install-service.js';
import { control } from './local-control.js';
import { root } from './contracts.js';
import { inspectMacAccount } from './adapters/macos-inspection.js';
import { inspectMacRegistry } from './adapters/macos-service-probes.js';
import { probeTrustedPath } from './adapters/trusted-presence.js';
import { bindReviewedCoreRuntime } from './adapters/runtime-authority.js';
import { createReviewedLocalControlPorts } from './a-integration.js';

function unavailable(code: Result['code'] = 'INVALID_CONFIG'): Result {
  return { ok: false, code };
}

function refusedPreview(code: Preview['code'] = 'INVALID_CONFIG'): Preview {
  return { ok: false, code, configDigest: '', previousInstallDigest: null, releaseDigest: '', roles: [] };
}

async function reviewedPreview(
  config: ServiceConfig,
  acl: ReturnType<typeof createSystemBootstrapAclProbe>,
): Promise<Preview> {
  try {
    return await preview(config, config.releaseDigest, createMacInspector(acl));
  } catch {
    return refusedPreview('INTERNAL_ERROR');
  }
}


async function confirmedNoManagedInstallation(
  acl: ReturnType<typeof createSystemBootstrapAclProbe>,
): Promise<boolean> {
  try {
    for (const relative of Object.values(installPaths)) {
      if (await probeTrustedPath('/', 0, acl, relative) !== 'absent') return false;
    }
    const registry = await inspectMacRegistry();
    return registry !== null
      && registry.jobs.core === 'absent'
      && registry.jobs.tunnel === 'absent';
  } catch {
    return false;
  }
}

function matchesExpected(current: Preview, request: ExpectedInstallRequest): boolean {
  return current.ok === true
    && current.code === 'OK'
    && current.configDigest === request.expectedPreviewDigest
    && current.previousInstallDigest === request.expectedInstallDigest;
}

/**
 * Public operator CLI composition for the target Mac.
 *
 * No arbitrary path/label/command input exists. The symbolic service config
 * resolves only to the fixed root-owned candidate-service.json whose sealed
 * release is independently inspected. Mutations still require the native
 * InstallPorts local-admin gate; this factory performs no elevation.
 *
 * Rollback is intentionally absent until target-owned exact schema sets and a
 * native DB-closure proof are available. reset-failure remains fail-closed
 * through the native ports until the typed runtime-user reset channel exists.
 */
export function createSystemOperatorCliDeps(output: CliDeps['output']): CliDeps {
  const acl = createSystemBootstrapAclProbe();

  const candidate = async (): Promise<ServiceConfig | null> => {
    try { return await readSystemCandidateConfig(acl); }
    catch { return null; }
  };

  const getPreview = async (): Promise<Preview> => {
    const config = await candidate();
    return config === null ? refusedPreview() : reviewedPreview(config, acl);
  };

  return Object.freeze({
    preview: getPreview,
    status: () => createSystemDiagnosticEvidence(acl),
    async apply(request: ExpectedInstallRequest): Promise<Result> {
      const config = await candidate();
      if (config === null) return unavailable();
      const current = await reviewedPreview(config, acl);
      if (!matchesExpected(current, request)) return unavailable('CONFIG_CHANGED');
      const result = await apply(current, config, createSystemNativeInstallPorts(config));
      return result.ok === true && result.code === 'OK'
        ? { ok: true, code: 'OK' }
        : { ok: false, code: result.code };
    },
    async control(action: LocalControlAction, request: ExpectedInstallRequest): Promise<Result> {
      // R3 narrow idempotence: an already-uninstalled system may retain a
      // launchd disabled override, which is not an installation identity.
      // Only uninstall can succeed in this state, and it performs no mutation.
      if (action === 'uninstall' && await confirmedNoManagedInstallation(acl)) {
        return { ok: true, code: 'OK' };
      }

      const config = await candidate();
      if (config === null) return unavailable();
      const current = await reviewedPreview(config, acl);
      let ports = createSystemNativeInstallPorts(config);
      if (!matchesExpected(current, request)) {
        if (action !== 'stop' && action !== 'restart' && action !== 'uninstall') {
          return unavailable('CONFIG_CHANGED');
        }
        try {
          const running = createSystemNativeRunningControlPorts(config);
          const prior = await running.readPrior();
          if (prior.digest === null
            || request.expectedInstallDigest !== prior.digest
            || request.expectedPreviewDigest !== reviewToken(config, config.releaseDigest, prior.digest)) {
            return unavailable('CONFIG_CHANGED');
          }
          ports = running;
        } catch {
          return unavailable('CONFIG_CHANGED');
        }
      }
      if (action === 'reset-failure') {
        const account = await inspectMacAccount();
        if (account === null || account.admin !== false) return unavailable('ACCOUNT_INVALID');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5_000);
        try {
          const review = await createInstalledRuntimeReviewSource({
            anchor: '/',
            relative: root.slice(1),
            ownerUid: 0,
            runtimeUid: account.uid,
            runtimeGid: account.gid,
            acl,
          }).read(controller.signal);
          if (review === null || controller.signal.aborted) return unavailable('PARTIAL_INSTALL');
          const runtime = await bindReviewedCoreRuntime(review, acl, controller.signal);
          if (runtime === null || controller.signal.aborted) return unavailable('PARTIAL_INSTALL');
          ports = createReviewedLocalControlPorts(ports, runtime);
        } finally {
          clearTimeout(timer);
          controller.abort();
        }
      }
      const result = await control(action, ports);
      return result.ok === true && result.code === 'OK'
        ? { ok: true, code: 'OK' }
        : { ok: false, code: result.code };
    },
    output,
  });
}
