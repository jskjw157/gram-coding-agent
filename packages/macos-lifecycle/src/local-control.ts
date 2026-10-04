import type { SafeCode } from './contracts.js';
import {
  isControlAction,
  type ControlAction,
  type InstallPorts,
  type InstallResult,
} from './installation-transaction/contracts.js';
import type { LocalControlRestorePort } from './installation-transaction/control-contracts.js';
import { reconcileJournal } from './installation-transaction/journal.js';
import { validateManifestBytes } from './adapters/install-files.js';
import { parseConfig } from './config.js';

function fail(code: SafeCode): InstallResult {
  return { ok: false, code };
}

/** Strip service/reset extras (stage/raw/...) to the fixed {ok,code} shape. */
function sanitize(result: InstallResult): InstallResult {
  if (result.ok === true) return { ok: true, code: 'OK' };
  return { ok: false, code: result.code };
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
  let authed: boolean;
  try {
    authed = await ports.authorizeLocalAdmin();
  } catch {
    return fail('NOT_AUTHORIZED');
  }
  if (authed !== true) return fail('NOT_AUTHORIZED');

  let session;
  try {
    session = await ports.lock();
  } catch {
    return fail('PARTIAL_INSTALL');
  }
  if (session.acquired !== true) return fail('BUSY');
  const run = async (): Promise<InstallResult> => {
    let prior;
    try {
      prior = await ports.readPrior();
    } catch {
      return fail('PARTIAL_INSTALL');
    }
    // Config-first: malformed prior config is FOREIGN_SERVICE before ANY
    // service mutation (start/restart must not stop or start first).
    if (prior.config !== null) {
      try {
        parseConfig(JSON.parse(prior.config.toString('utf8')));
      } catch {
        return fail('FOREIGN_SERVICE');
      }
    }
    // Journal gate: anything but clean-absent/clean-committed is
    // PARTIAL_INSTALL with zero service calls. Status never repairs.
    let journal: Buffer | null;
    try {
      journal = await ports.journal().read();
    } catch {
      return fail('PARTIAL_INSTALL');
    }
    if (reconcileJournal(journal, prior.manifest).state === 'partial') return fail('PARTIAL_INSTALL');
    const services = ports.services();

    const stopBoth = async (): Promise<InstallResult | null> => {
      try {
        const stopTunnel = await services.stop('tunnel');
        if (stopTunnel.ok !== true) return sanitize(stopTunnel);
        const stopCore = await services.stop('core');
        if (stopCore.ok !== true) return sanitize(stopCore);
        if (await services.isStopped('tunnel') !== true) return fail('PARTIAL_INSTALL');
        if (await services.isStopped('core') !== true) return fail('PARTIAL_INSTALL');
        return null;
      } catch (error) {
        if (error instanceof Error && error.message === 'INTERRUPTED') return fail('PARTIAL_INSTALL');
        return fail('PARTIAL_INSTALL');
      }
    };

    const startDesired = async (): Promise<InstallResult | null> => {
      let coreStarted = false;
      let tunnelStarted = false;
      const compensate = async (): Promise<void> => {
        if (tunnelStarted) {
          tunnelStarted = false;
          try {
            await services.stop('tunnel');
          } catch { /* best-effort; the original failure is preserved */ }
        }
        if (!coreStarted) return;
        coreStarted = false;
        try {
          await services.stop('core');
        } catch { /* best-effort; the original failure is preserved */ }
      };
      try {
        // Lab disabled snapshot: desired state is stopped. Starting here
        // reflects an explicit local start request, verified by owned health.
        const startCore = await services.start('core');
        if (startCore.ok !== true) return sanitize(startCore);
        coreStarted = true;
        if (await services.ownedHealthy('core') !== true) {
          await compensate();
          return fail('HEALTH_UNKNOWN');
        }
        if (prior.config !== null) {
          let tunnelEnabled = false;
          try {
            const parsed: unknown = JSON.parse(prior.config.toString('utf8'));
            const tunnel = (parsed as { tunnel?: { enabled?: unknown } }).tunnel;
            tunnelEnabled = tunnel !== null && typeof tunnel === 'object'
              && (tunnel as { enabled?: unknown }).enabled === true;
          } catch {
            await compensate();
            return fail('FOREIGN_SERVICE');
          }
          if (tunnelEnabled) {
            const startTunnel = await services.start('tunnel');
            if (startTunnel.ok !== true) {
              await compensate();
              return sanitize(startTunnel);
            }
            tunnelStarted = true;
            if (await services.ownedHealthy('tunnel') !== true) {
              await compensate();
              return fail('HEALTH_UNKNOWN');
            }
          }
        }
        return null;
      } catch (error) {
        await compensate();
        if (error instanceof Error && error.message === 'INTERRUPTED') return fail('PARTIAL_INSTALL');
        return fail('PARTIAL_INSTALL');
      }
    };

    switch (action) {
      case 'stop': {
        if (prior.digest === null) {
          let coreStopped: boolean;
          let tunnelStopped: boolean;
          try {
            coreStopped = await services.isStopped('core');
            tunnelStopped = await services.isStopped('tunnel');
          } catch {
            return fail('PARTIAL_INSTALL');
          }
          if (coreStopped === true && tunnelStopped === true) return { ok: true, code: 'OK' };
          const stopped = await stopBoth();
          if (stopped !== null) return stopped;
          return fail('PARTIAL_INSTALL');
        }
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
        if (prior.digest === null || prior.manifest === null
          || !validateManifestBytes(prior.manifest)) return fail('FOREIGN_SERVICE');
        const stopped = await stopBoth();
        if (stopped !== null) return stopped;
        const started = await startDesired();
        if (started !== null) return started;
        return { ok: true, code: 'OK' };
      }
      case 'reset-failure': {
        if (prior.digest === null || prior.manifest === null
          || !validateManifestBytes(prior.manifest)) return fail('FOREIGN_SERVICE');
        // Confirmed stop + local authorization (already checked) + runtime UID
        // via the sealed narrow reset helper. No general helper/callback that
        // creates root-owned records the supervisor cannot update.
        const stopped = await stopBoth();
        if (stopped !== null) return stopped;
        if (await services.isStopped('core') !== true) return fail('PARTIAL_INSTALL');
        const maybe = (ports.restore() as unknown as { resetStoppedFailure?: unknown }).resetStoppedFailure;
        if (typeof maybe !== 'function') return fail('PARTIAL_INSTALL');
        let reset: InstallResult;
        try {
          reset = await (maybe as NonNullable<LocalControlRestorePort['resetStoppedFailure']>)();
        } catch {
          return fail('PARTIAL_INSTALL');
        }
        if (reset.ok !== true) return sanitize(reset);
        // Revalidate and start only as previously desired. The supported lab
        // snapshot is disabled, so reset leaves jobs stopped after recovery.
        return { ok: true, code: 'OK' };
      }
      case 'uninstall': {
        const stopped = await stopBoth();
        if (stopped !== null) return stopped;
        if (prior.digest === null) {
          if (prior.corePlist === null && prior.tunnelPlist === null) return { ok: true, code: 'OK' };
          return fail('FOREIGN_SERVICE');
        }
        try {
          const restore = ports.restore();
          if (prior.corePlist !== null) {
            const removedCore = await restore.removeManifestOwned('core', prior.corePlist);
            // R3: denial/uncertainty preserves foreign files as bounded failure.
            if (removedCore !== true) return fail('FOREIGN_SERVICE');
          }
          if (prior.tunnelPlist !== null) {
            const removedTunnel = await restore.removeManifestOwned('tunnel', prior.tunnelPlist);
            if (removedTunnel !== true) return fail('FOREIGN_SERVICE');
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
  };
  let result: InstallResult;
  try {
    result = await run();
  } catch {
    try {
      await session.release();
    } catch { /* already failing; preserve bounded failure */ }
    return fail('PARTIAL_INSTALL');
  }
  try {
    await session.release();
  } catch {
    // R5: committed-but-cleanup-uncertain is never clean success; never
    // retry unknown writes blindly. Preserve failures, downgrade success.
    if (result.ok) return fail('PARTIAL_INSTALL');
    return result;
  }
  return result;
}
