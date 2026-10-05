import type { DiagnosticEvidence } from './cli-contracts.js';
import type { AclProbe } from './adapters/trusted-files.js';
import { createInstalledHealthObserver } from './a-native-observer.js';

async function observed(
  observe: ReturnType<typeof createInstalledHealthObserver>['observe'],
  role: 'core' | 'tunnel',
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    return await observe(role, controller.signal);
  } catch {
    return { status: null, currentIdentity: null };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/**
 * Native diagnostic evidence. A role identity is present only when the exact
 * execution reservation, registration, sealed executable, native process and
 * fresh supervisor telemetry all still agree.
 */
export async function createSystemDiagnosticEvidence(
  acl: AclProbe,
): Promise<DiagnosticEvidence> {
  const observer = createInstalledHealthObserver(acl);
  const [core, tunnel] = await Promise.all([
    observed(observer.observe, 'core'),
    observed(observer.observe, 'tunnel'),
  ]);
  const nowMs = Date.now();
  return {
    nowMs: Number.isSafeInteger(nowMs) && nowMs >= 0 ? nowMs : 0,
    core,
    tunnel,
  };
}
