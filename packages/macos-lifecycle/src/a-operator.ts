import type { Preview, Result, ServiceConfig } from './contracts.js';
import type { CliDeps, ExpectedInstallRequest, LocalControlAction } from './cli-contracts.js';
import { preview } from './preflight.js';
import { createMacInspector } from './adapters/native-inspector.js';
import { createSystemBootstrapAclProbe } from './a-system-sources.js';
import { readSystemCandidateConfig } from './a-candidate-config.js';
import { createSystemNativeInstallPorts } from './a-native-install.js';
import { createSystemDiagnosticEvidence } from './a-native-diagnostic.js';
import { apply } from './install-service.js';
import { control } from './local-control.js';

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
      const config = await candidate();
      if (config === null) return unavailable();
      const current = await reviewedPreview(config, acl);
      if (!matchesExpected(current, request)) return unavailable('CONFIG_CHANGED');
      const result = await control(action, createSystemNativeInstallPorts(config));
      return result.ok === true && result.code === 'OK'
        ? { ok: true, code: 'OK' }
        : { ok: false, code: result.code };
    },
    output,
  });
}
