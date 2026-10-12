import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { expect, vi } from 'vitest';
import { SecretRedactor } from '@gram/secrets';
import {
  WindowsClipboardService,
  type ClipboardAuditEvent,
  type WindowsClipboardOptions,
} from '@gram/windows-integration';

export type NativeRole = 'wslpath' | 'explorer.exe' | 'powershell.exe';
export type NativeMode =
  | 'success' | 'bytes' | 'chunked' | 'nonzero' | 'signal' | 'stdout-overflow'
  | 'stderr-overflow' | 'stderr' | 'hang' | 'exited-with-pipes' | 'stderr-with-pipes';
export interface NativeCall {
  role: NativeRole;
  pid: number;
  args: string[];
  environment: Record<string, string>;
}
export const privateCanary = 'synthetic-windows-escape-private-value';
export const marker = '***REDACTED***';

function records<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as T);
}

export function actualChildren(): ChildProcess[] {
  return [...vi.mocked(execFile).mock.results, ...vi.mocked(spawn).mock.results]
    .filter(result => result.type === 'return')
    .map(result => result.value as ChildProcess);
}

export function createWindowsFixture() {
  const root = mkdtempSync(join(tmpdir(), 'gram-windows-escape-'));
  const directory = join(root, 'existing directory 한글');
  const windowsPath = 'R:\\Windows escape fixture\\한글 & data';
  mkdirSync(directory);
  const events: ClipboardAuditEvent[] = [];
  const program = '#!' + process.execPath + '\n' +
    readFileSync(new URL('./windows-escape-native.fixture.cjs', import.meta.url), 'utf8');

  function configure(
    role: NativeRole,
    mode: NativeMode = 'success',
    bytes: Uint8Array = Buffer.alloc(0),
    paths: { linuxPath?: string; windowsPath?: string } = {},
  ): void {
    writeFileSync(join(root, role + '.json'), JSON.stringify({
      mode, diagnostic: privateCanary, linuxPath: paths.linuxPath ?? directory,
      windowsPath: paths.windowsPath ?? windowsPath,
    }));
    writeFileSync(join(root, role + '.output'), bytes);
  }
  for (const role of ['wslpath', 'explorer.exe', 'powershell.exe'] as const) {
    writeFileSync(join(root, role), program, { mode: 0o700 });
    configure(role);
  }
  vi.stubEnv('PATH', root);
  vi.stubEnv('GRAM_WINDOWS_ESCAPE_CANARY', privateCanary);
  vi.stubEnv('WSLENV', 'GRAM_WINDOWS_ESCAPE_CANARY');

  return {
    root, directory, windowsPath, events, configure,
    calls: () => records<NativeCall>(join(root, 'calls.ndjson')),
    stdin: () => readFileSync(join(root, 'stdin.bin')),
    clipboard(secrets: readonly string[] = [], overrides: Partial<WindowsClipboardOptions> = {}) {
      return new WindowsClipboardService({
        redactor: new SecretRedactor(secrets), registeredSecrets: secrets,
        audit: { record: event => { events.push(event); } },
        ...overrides,
      });
    },
    cleanup() {
      for (const child of actualChildren()) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      for (const child of records<{ pid: number; script: string }>(join(root, 'descendants.ndjson'))) {
        try {
          // Do not signal a reused PID: identify our exact authored fixture first.
          const argv = readFileSync('/proc/' + child.pid + '/cmdline', 'utf8').split('\0');
          if (argv.includes(child.script) && argv.includes('--windows-escape-hold-pipes')) {
            process.kill(child.pid, 'SIGKILL');
          }
        } catch {
          // The owned fixture may already have exited.
        }
      }
      vi.unstubAllEnvs();
      vi.clearAllMocks();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export async function safeFailure(promise: Promise<unknown>, code: string, canaries: readonly string[] = []) {
  const outcome = await promise.then(
    value => ({ ok: true as const, value }),
    error => ({ ok: false as const, error: error as unknown }),
  );
  // A mistaken successful response reports a boolean, not its potential secret body.
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error('Expected the public boundary to reject.');
  const error = outcome.error;
  expect(error).toBeInstanceOf(Error);
  expect(error).toHaveProperty('code', code);
  for (const key of ['cause', 'stdout', 'stderr', 'args', 'command', 'script', 'env']) {
    expect(error).not.toHaveProperty(key);
  }
  const diagnostic = inspect(error, { getters: false, depth: 5 }) + JSON.stringify(error);
  for (const canary of [privateCanary, ...canaries]) expect(diagnostic.includes(canary)).toBe(false);
  return error;
}

export async function observeParentSinks<T>(action: () => Promise<T>): Promise<{ value: T; output: string }> {
  const chunks: string[] = [];
  const collect = (chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  };
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(collect);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(collect);
  const logs = ['log', 'info', 'warn', 'error', 'debug'].map(method =>
    vi.spyOn(console, method as 'log').mockImplementation((...values: unknown[]) => {
      chunks.push(inspect(values, { getters: false }));
    }),
  );
  try {
    return { value: await action(), output: chunks.join('') };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    for (const log of logs) log.mockRestore();
  }
}
