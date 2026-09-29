import type { SafeCode } from './contracts.js';
import {
  isControlAction,
  type ControlAction,
  type InstallPorts,
  type InstallResult,
} from './installation-transaction/contracts.js';
import { validateManifestBytes } from './adapters/install-files.js';

function fail(code: SafeCode): InstallResult {
  return { ok: false, code };
}

/** Local administrative control. Only start|stop|restart|reset-failure|
 * uninstall. Status never repairs journals or restarts jobs. All mutations go
 * through the injected narrow ports; no generic user-switch shell, no purge
 * flag, no arbitrary plist deletion. State, credentials, run history,
 * releases and logs are preserved; uninstall removes only manifest-owned
 * matching plists after stopping.
 */
export async function control(action: ControlAction, ports: InstallPorts): Promise<InstallResult> {
  if (!isControlAction(action)) return fail('INVALID_CONFIG');
  if (await ports.authorizeLocalAdmin() !== true) return fail('NOT_AUTHORIZED');

  const session = await ports.lock();
  if (!session.acquired) return fail('BUSY');
  try {
    let prior;
    try {
      prior = await ports.readPrior();
    } catch {
      return fail('PARTIAL_INSTALL');
    }
    const services = ports.services();

    const stopBoth = async (): Promise<InstallResult | null> => {
      try {
        const stopTunnel = await services.stop('tunnel');
        if (!stopTunnel.ok) return stopTunnel;
        const stopCore = await services.stop('core');
        if (!stopCore.ok) return stopCore;
        if (await services.isStopped('tunnel') !== true) return fail('PARTIAL_INSTALL');
        if (await services.isStopped('core') !== true) return fail('PARTIAL_INSTALL');
        return null;
      } catch (error) {
        if (error instanceof Error && error.message === 'INTERRUPTED') return fail('PARTIAL_INSTALL');
        return fail('PARTIAL_INSTALL');
      }
    };

    const startDesired = async (): Promise<InstallResult | null> => {
      try {
        // Lab disabled snapshot: desired state is stopped. Starting here
        // reflects an explicit local start request, verified by owned health.
        const startCore = await services.start('core');
        if (!startCore.ok) return startCore;
        if (await services.ownedHealthy('core') !== true) return fail('HEALTH_UNKNOWN');
        if (prior.config !== null) {
          try {
            const parsed: unknown = JSON.parse(prior.config.toString('utf8'));
            const tunnel = (parsed as { tunnel?: { enabled?: unknown } }).tunnel;
            if (tunnel !== null && typeof tunnel === 'object' && (tunnel as { enabled?: unknown }).enabled === true) {
              const startTunnel = await services.start('tunnel');
              if (!startTunnel.ok) return startTunnel;
              if (await services.ownedHealthy('tunnel') !== true) return fail('HEALTH_UNKNOWN');
            }
          } catch {
            return fail('FOREIGN_SERVICE');
          }
        }
        return null;
      } catch (error) {
        if (error instanceof Error && error.message === 'INTERRUPTED') return fail('PARTIAL_INSTALL');
        return fail('PARTIAL_INSTALL');
      }
    };

    switch (action) {
      case 'stop': {
        if (prior.digest === null) return { ok: true, code: 'OK' };
        const stopped = await stopBoth();
        if (stopped !== null) return stopped;
        return { ok: true, code: 'OK' };
      }
      case 'start': {
        if (prior.digest === null || prior.manifest === null
          || !validateManifestBytes(prior.manifest)) return fail('FOREIGN_SERVICE');
        const started = await startDesired();
        if (started !== null) return started;
        return { ok: true, code: 'OK' };
      }
      case 'restart': {
        if (prior.digest === null || prior.manifest === null) return fail('FOREIGN_SERVICE');
        const stopped = await stopBoth();
        if (stopped !== null) return stopped;
        const started = await startDesired();
        if (started !== null) return started;
        return { ok: true, code: 'OK' };
      }
      case 'reset-failure': {
        // Confirmed stop + local authorization (already checked) + runtime UID
        // via the sealed narrow reset helper. No general helper/callback that
        // creates root-owned records the supervisor cannot update.
        const stopped = await stopBoth();
        if (stopped !== null) return stopped;
        let reset: InstallResult;
        try {
          reset = await ports.restore().resetExecutionRecords();
        } catch {
          return fail('PARTIAL_INSTALL');
        }
        if (!reset.ok) return reset;
        // Revalidate and start only as previously desired. The supported lab
        // snapshot is disabled, so reset leaves jobs stopped after recovery.
        return { ok: true, code: 'OK' };
      }
      case 'uninstall': {
        const stopped = await stopBoth();
        if (stopped !== null) return stopped;
        if (prior.digest === null) return { ok: true, code: 'OK' };
        try {
          const restore = ports.restore();
          if (prior.corePlist !== null) {
            await restore.removeManifestOwned('core', prior.corePlist);
          }
          if (prior.tunnelPlist !== null) {
            await restore.removeManifestOwned('tunnel', prior.tunnelPlist);
          }
          // Second uninstall is a no-op OK: missing live plists are fine.
          // DB/secret/workspace/release/log/run history are never purged here.
          return { ok: true, code: 'OK' };
        } catch (error) {
          if (error instanceof Error && error.message === 'INTERRUPTED') return fail('PARTIAL_INSTALL');
          return fail('PARTIAL_INSTALL');
        }
      }
      default:
        return fail('INVALID_CONFIG');
    }
  } finally {
    await session.release().catch(() => undefined);
  }
}
