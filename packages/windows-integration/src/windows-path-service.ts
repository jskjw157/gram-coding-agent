export interface WindowsPathInvocation {
  readonly executable: 'wslpath';
  readonly args: readonly ['-w' | '-u', string];
}

export interface WindowsPathRunner {
  run(request: WindowsPathInvocation): Promise<string>;
}

export type WindowsPathErrorCode = 'INVALID_PATH' | 'INVALID_OUTPUT' | 'CONVERSION_FAILED';

const messages: Record<WindowsPathErrorCode, string> = {
  INVALID_PATH: 'Invalid path for conversion.',
  INVALID_OUTPUT: 'wslpath returned an invalid path.',
  CONVERSION_FAILED: 'wslpath conversion failed.',
};

export class WindowsPathError extends Error {
  constructor(readonly code: WindowsPathErrorCode) {
    super(messages[code]);
    this.name = 'WindowsPathError';
  }
}

const maxPathLength = 8192;

function isPathString(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxPathLength
    && value.trim().length > 0
    && !value.includes('\0')
    && !value.includes('\r')
    && !value.includes('\n')
    // With the Unicode flag, paired surrogates are one code point and do not match.
    && !/[\uD800-\uDFFF]/u.test(value);
}

export class WindowsPathService {
  constructor(private readonly runner: WindowsPathRunner) {}

  toWindows(linuxPath: string): Promise<string> {
    return this.convert('-w', linuxPath);
  }

  toLinux(windowsPath: string): Promise<string> {
    return this.convert('-u', windowsPath);
  }

  private async convert(direction: '-w' | '-u', path: string): Promise<string> {
    // Direct argv prevents shell evaluation; this also prevents option injection.
    if (!isPathString(path) || path.startsWith('-')) throw new WindowsPathError('INVALID_PATH');

    let output: unknown;
    try {
      output = await this.runner.run({ executable: 'wslpath', args: [direction, path] });
    } catch {
      // Native errors may contain argv, stdout and stderr. Do not retain a cause.
      throw new WindowsPathError('CONVERSION_FAILED');
    }

    const converted = typeof output === 'string' ? output.replace(/\r?\n$/, '') : output;
    if (!isPathString(converted)) throw new WindowsPathError('INVALID_OUTPUT');
    return converted;
  }
}
