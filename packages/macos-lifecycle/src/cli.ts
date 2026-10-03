import type { Preview, Result, SafeCode } from './contracts.js';
import type { CliCode, CliDeps, CliPreviewReport, CliResultReport, ExpectedInstallRequest,
  LifecycleReport, LocalControlAction, MutationAction, RollbackRequest } from './cli-contracts.js';
import { projectStatus } from './diagnostic.js';

type Action = MutationAction | 'preview' | 'status';
type Command = { action: 'preview' } | { action: 'status' }
  | { action: 'rollback'; request: RollbackRequest }
  | { action: 'apply' | LocalControlAction; request: ExpectedInstallRequest };
const controls = new Set<string>(['start', 'stop', 'restart', 'reset-failure', 'uninstall']);
const codes = {
  OK: true, UNSUPPORTED_HOST: true, INVALID_CONFIG: true, ACCOUNT_INVALID: true,
  UNTRUSTED_RELEASE: true, UNSAFE_PATH: true, FOREIGN_SERVICE: true, PORT_IN_USE: true,
  CONFIG_CHANGED: true, BUSY: true, AUTH_BLOCKED: true, HEALTH_UNKNOWN: true,
  TOOL_SURFACE_MISMATCH: true, RESTART_BUDGET: true, INVALID_HISTORY: true,
  ROLLBACK_BLOCKED_SCHEMA: true, PARTIAL_INSTALL: true, NOT_AUTHORIZED: true,
  TUNNEL_COMPATIBILITY_REQUIRED: true, INTERNAL_ERROR: true,
} satisfies Record<SafeCode, true>;
function safeCode(value: unknown): value is SafeCode {
  return typeof value === 'string' && Object.hasOwn(codes, value);
}
function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) return null;
    copy[key] = descriptor.value;
  }
  return copy;
}
function strings(value: unknown, maximum: number): string[] | null {
  if (!Array.isArray(value)) return null;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length: unknown = lengthDescriptor?.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > maximum) return null;
  if (Reflect.ownKeys(value).length !== length + 1) return null;
  const copy: string[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor) || typeof descriptor.value !== 'string'
      || descriptor.value.length > 128) return null;
    copy.push(descriptor.value);
  }
  return copy;
}
function parse(argv: readonly string[]): Command | null {
  const args = strings(argv, 32);
  if (!args) return null;
  if (args.length === 0) return { action: 'preview' };
  const action = args[0];
  if (action === 'preview' || action === 'status') {
    return args.length === 2 && args[1] === '--json' ? { action } : null;
  }
  if (action !== 'apply' && action !== 'rollback' && !controls.has(action ?? '')) return null;
  const required = ['--config', '--expected-config-digest', '--expected-install-digest', '--json'];
  if (action === 'rollback') required.push('--target-release-digest');
  const options = new Map<string, string>();
  for (let index = 1; index < args.length; index++) {
    const flag = args[index];
    if (!flag || !required.includes(flag) || options.has(flag)) return null;
    if (flag === '--json') { options.set(flag, ''); continue; }
    const value = args[++index];
    if (!value || value.startsWith('--')) return null;
    options.set(flag, value);
  }
  const token = options.get('--expected-config-digest'); const installation = options.get('--expected-install-digest');
  if (options.size !== required.length || options.get('--config') !== 'service' || !digest(token)
    || !(installation === 'none' || digest(installation))) return null;
  const request: ExpectedInstallRequest = { config: 'service', expectedPreviewDigest: token,
    expectedInstallDigest: installation === 'none' ? null : installation };
  if (action === 'rollback') {
    const target = options.get('--target-release-digest');
    return digest(target) ? { action, request: Object.freeze({ ...request, targetReleaseDigest: target }) } : null;
  }
  return { action: action as 'apply' | LocalControlAction, request: Object.freeze(request) };
}
function operationResult(value: unknown): Result | null {
  const result = record(value, ['ok', 'code']);
  if (!result || typeof result.ok !== 'boolean' || !safeCode(result.code)
    || result.ok !== (result.code === 'OK')) return null;
  return { ok: result.ok, code: result.code };
}
function previewResult(value: unknown): Preview | null {
  const result = record(value, ['ok', 'code', 'configDigest', 'previousInstallDigest', 'releaseDigest', 'roles']);
  if (!result || typeof result.ok !== 'boolean' || !safeCode(result.code)
    || result.ok !== (result.code === 'OK')) return null;
  const roles = strings(result.roles, 2);
  if (!roles) return null;
  if (!result.ok) {
    return result.configDigest === '' && result.previousInstallDigest === null && result.releaseDigest === '' && roles.length === 0
      ? { ok: false, code: result.code, configDigest: '', previousInstallDigest: null, releaseDigest: '', roles: [] } : null;
  }
  if (!digest(result.configDigest) || !digest(result.releaseDigest)
    || !(result.previousInstallDigest === null || digest(result.previousInstallDigest))
    || !(roles.length === 1 && roles[0] === 'core' || roles.length === 2 && roles[0] === 'core' && roles[1] === 'tunnel')) return null;
  return { ok: true, code: result.code, configDigest: result.configDigest,
    previousInstallDigest: result.previousInstallDigest, releaseDigest: result.releaseDigest,
    roles: roles.length === 2 ? ['core', 'tunnel'] : ['core'] };
}
function resultReport(action: Action | null, ok: boolean, code: CliCode): CliResultReport {
  return { schemaVersion: 1, mode: 'LAB_ONLY', action, businessReadiness: 'UNAVAILABLE', result: { ok, code } };
}

/** No executable entry or native factory here. A supplies narrowly authorized
 * local ports. Parsing/output cannot confer privilege or create owned health.
 */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  let action: Action | null = null; let exit: number;
  let report: LifecycleReport | CliPreviewReport | CliResultReport;
  try {
    const command = parse(argv);
    if (!command) { exit = 64; report = resultReport(null, false, 'INVALID_USAGE'); }
    else {
      action = command.action;
      const portKey = command.action === 'preview' ? 'preview' : command.action === 'status' ? 'status'
        : command.action === 'apply' ? 'apply' : command.action === 'rollback' ? 'rollback' : 'control';
      if (typeof deps[portKey] !== 'function') { exit = 2; report = resultReport(action, false, 'CAPABILITY_UNAVAILABLE'); }
      else {
        let raw: unknown;
        if (command.action === 'preview') raw = await deps.preview?.();
        else if (command.action === 'status') raw = await deps.status?.();
        else if (command.action === 'apply') raw = await deps.apply?.(command.request);
        else if (command.action === 'rollback') raw = await deps.rollback?.(command.request);
        else raw = await deps.control?.(command.action, command.request);
        if (command.action === 'preview') {
          const preview = previewResult(raw);
          if (!preview) throw new Error('INTERNAL_ERROR');
          exit = preview.ok ? 0 : preview.code === 'INTERNAL_ERROR' ? 70 : 2;
          report = { schemaVersion: 1, mode: 'LAB_ONLY', action: 'preview', businessReadiness: 'UNAVAILABLE', preview };
        } else if (command.action === 'status') {
          const input = record(raw, ['nowMs', 'core', 'tunnel']);
          if (!input || typeof input.nowMs !== 'number' || !Number.isSafeInteger(input.nowMs) || input.nowMs < 0) throw new Error('INTERNAL_ERROR');
          report = projectStatus(input); exit = 0;
        } else {
          const result = operationResult(raw);
          if (!result) throw new Error('INTERNAL_ERROR');
          report = resultReport(action, result.ok, result.code);
          exit = result.ok ? 0 : result.code === 'INTERNAL_ERROR' ? 70 : 2;
        }
      }
    }
  } catch { report = resultReport(action, false, 'INTERNAL_ERROR'); exit = 70; }
  try {
    const line = JSON.stringify(report) + '\n';
    if (line.length > 65536) return 70;
    await deps.output(line);
    return exit;
  } catch { return 70; }
}
