import type {
  InstallPorts,
  InstallResult,
  RestorePort,
} from './contracts.js';

/**
 * MAC-02 local-control narrow capability contracts.
 *
 * `local-control.ts` currently drives recovery through the broad
 * `RestorePort.resetExecutionRecords()` entry. The later cutover consumes the
 * optional narrow capability below instead, so stopped-failure recovery can be
 * authorized without exposing the general execution-records reset.
 *
 * `InstallResult` already carries the shared `SafeCode` union from
 * `../contracts.js` (`OK`, `FOREIGN_SERVICE`, `PARTIAL_INSTALL`,
 * `NOT_AUTHORIZED`, `BUSY`, `INVALID_CONFIG`, `HEALTH_UNKNOWN`, ...); no new
 * codes are invented here. Types only; no runtime behavior.
 */
export interface LocalControlRestorePort extends RestorePort {
  resetStoppedFailure?(): Promise<InstallResult>;
}

export interface LocalControlPorts extends InstallPorts {
  restore(): LocalControlRestorePort;
}
