export type FixedWindowsOperation =
  | { readonly kind: 'OPEN_PATH'; readonly windowsPath: string }
  | { readonly kind: 'REVEAL_PATH'; readonly windowsPath: string }
  | { readonly kind: 'OPEN_URL'; readonly url: string };

export interface WindowsOperationRunner {
  run(operation: FixedWindowsOperation): Promise<void>;
}

function readOperation(value: unknown): FixedWindowsOperation {
  let kind: unknown;
  let target: unknown;
  try {
    if (typeof value !== 'object' || value === null) throw new Error();
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    const kindDescriptor = Object.getOwnPropertyDescriptor(value, 'kind');
    if (!kindDescriptor || !Object.hasOwn(kindDescriptor, 'value')) throw new Error();
    kind = kindDescriptor.value;
    if (kind !== 'OPEN_PATH' && kind !== 'REVEAL_PATH' && kind !== 'OPEN_URL') throw new Error();
    const targetKey = kind === 'OPEN_URL' ? 'url' : 'windowsPath';
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || keys.some((key) => key !== 'kind' && key !== targetKey)) throw new Error();
    const descriptor = Object.getOwnPropertyDescriptor(value, targetKey);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error();
    target = descriptor.value;
  } catch {
    throw new WindowsIntegrationError('INVALID_OPERATION');
  }

  // Copy validated primitives before any asynchronous work; never reread request data.
  if (kind === 'OPEN_URL') return { kind, url: normalizeHttpUrl(target) };
  if (kind === 'OPEN_PATH' || kind === 'REVEAL_PATH') return { kind, windowsPath: validateWindowsPath(target) };
  throw new WindowsIntegrationError('INVALID_OPERATION');
}

function linuxDirectoryPath(value: unknown): string {
  if (!isBoundedPath(value) || !value.startsWith('/') || value.startsWith('//')) {
    throw new WindowsIntegrationError('INVALID_PATH');
  }
  return value;
}

function executeExplorer(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'explorer.exe',
      args,
      { shell: false, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 65536 },
      (error) => {
        if (error) reject(error);
        else resolve();
      },
    );
  });
}

export class FixedWindowsRunner implements WindowsOperationRunner {
  constructor(private readonly paths: Pick<WindowsPathService, 'toLinux' | 'toWindows'> = new WindowsPathService()) {}

  async run(operation: FixedWindowsOperation): Promise<void> {
    try {
      const request = readOperation(operation);
      if (request.kind === 'OPEN_URL') {
        await executeExplorer([request.url]);
      } else if (request.kind === 'REVEAL_PATH') {
        // WSL quotes argv during interop: do not concatenate the switch with a spaced path.
        await executeExplorer(['/select,', request.windowsPath]);
      } else {
        const linux = linuxDirectoryPath(await this.paths.toLinux(request.windowsPath));
        const resolved = linuxDirectoryPath(await realpath(linux));
        if (!(await stat(resolved)).isDirectory()) throw new WindowsIntegrationError('NOT_DIRECTORY');
        const windows = validateWindowsPath(await this.paths.toWindows(resolved));
        // Directory intent supplements the metadata check; this is not filesystem race isolation.
        const directory = validateWindowsPath(windows.endsWith('\\') ? windows : windows + '\\');
        await executeExplorer([directory]);
      }
    } catch (error) {
      // No retries or native argv/stdout/stderr/cause in public failures.
      throw sanitizeWindowsFailure(error);
    }
  }
}
import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { sanitizeWindowsFailure, WindowsIntegrationError } from './windows-integration-error.js';
import { WindowsPathService } from './windows-path-service.js';
import { isBoundedPath, normalizeHttpUrl, validateWindowsPath } from './windows-targets.js';

