import { execFile, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WindowsPathService } from './index.js';

// Observe the native boundary while still executing real Linux child processes.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

const fixtureSource = String.raw`
const fs = require('node:fs');
fs.writeFileSync(process.env.GRAM_PATH_TEST_CAPTURE, JSON.stringify(process.argv.slice(2)));
const mode = process.env.GRAM_PATH_TEST_MODE;
if (mode === 'nonzero') {
  process.stdout.write('/partial-result\n');
  process.stderr.write('private stderr: ' + process.argv[3]);
  process.exitCode = 7;
} else if (mode === 'signal') {
  process.kill(process.pid, 'SIGTERM');
} else if (mode === 'stdout-overflow') {
  process.stdout.write('x'.repeat(65537));
} else if (mode === 'stderr-overflow') {
  process.stderr.write('x'.repeat(65537));
} else if (mode === 'hang') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else {
  process.stdout.write(process.argv[2] === '-w' ? 'Z:\\fixture\\한글 file.txt\n' : '/fixture/한글 file.txt\n');
}
`;

describe.runIf(process.platform === 'linux')('default Linux process runner (fixture executable)', () => {
  let directory: string;
  let capture: string;

  beforeEach(() => {
    vi.mocked(execFile).mockClear();
    directory = mkdtempSync(join(tmpdir(), 'gram-wslpath-'));
    capture = join(directory, 'argv.json');
    writeFileSync(join(directory, 'wslpath'), `#!${process.execPath}\n${fixtureSource}`, { mode: 0o700 });
    vi.stubEnv('PATH', directory);
    vi.stubEnv('GRAM_PATH_TEST_CAPTURE', capture);
    vi.stubEnv('GRAM_PATH_TEST_MODE', 'success');
  });

  afterEach(() => {
    // Clean up even if a regression leaves the timeout fixture alive.
    for (const result of vi.mocked(execFile).mock.results) {
      if (result.type !== 'return') continue;
      const child = result.value as ChildProcess;
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it('executes the installed PATH converter directly and keeps shell syntax literal', async () => {
    const marker = join(directory, 'injected');
    const path = `/home/한글 'single' "double"; touch ${marker}; $(touch ${marker}) & `
      + '`touch ' + marker + '` %COMSPEC%';
    const service = new WindowsPathService();

    expect(await service.toWindows(path)).toBe('Z:\\fixture\\한글 file.txt');
    expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual(['-w', path]);
    expect(existsSync(marker)).toBe(false);
    expect(execFile).toHaveBeenCalledExactlyOnceWith(
      'wslpath', ['-w', path],
      expect.objectContaining({
        shell: false, encoding: 'utf8', timeout: 5000,
        killSignal: 'SIGKILL', maxBuffer: 65536,
      }),
      expect.any(Function),
    );
  });

  it('executes reverse conversion with a whole Windows path argument', async () => {
    const service = new WindowsPathService();
    expect(await service.toLinux('r:\\다른 사용자\\한글 file.txt')).toBe('/fixture/한글 file.txt');
    expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual(['-u', 'r:\\다른 사용자\\한글 file.txt']);
  });

  it.each(['nonzero', 'signal', 'stdout-overflow', 'stderr-overflow'])(
    'fails closed for %s without returning partial output or native error details', async (mode) => {
      vi.stubEnv('GRAM_PATH_TEST_MODE', mode);
      const path = '/private/path-that-must-not-appear';
      const error = await new WindowsPathService().toWindows(path).catch((cause: unknown) => cause);

      expect(execFile).toHaveBeenCalledTimes(1);
      expect(error).toMatchObject({ name: 'WindowsPathError', code: 'CONVERSION_FAILED' });
      expect(String(error)).not.toContain(path);
      expect(String(error)).not.toContain('private stderr');
      expect(error).not.toHaveProperty('cause');
      expect(error).not.toHaveProperty('stdout');
      expect(error).not.toHaveProperty('stderr');
    },
  );

  it('fails closed when wslpath is not installed instead of using a fallback mapper', async () => {
    rmSync(join(directory, 'wslpath'));
    await expect(new WindowsPathService().toWindows('/input')).rejects.toMatchObject({
      name: 'WindowsPathError', code: 'CONVERSION_FAILED',
    });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(existsSync(capture)).toBe(false);
  });

  it('kills a hung converter at the bounded deadline even if SIGTERM is ignored', async () => {
    vi.stubEnv('GRAM_PATH_TEST_MODE', 'hang');
    const started = performance.now();
    await expect(new WindowsPathService().toWindows('/input')).rejects.toMatchObject({
      name: 'WindowsPathError', code: 'CONVERSION_FAILED',
    });

    expect(execFile).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual(['-w', '/input']);
    expect(performance.now() - started).toBeLessThan(8000);
    const child = vi.mocked(execFile).mock.results[0]?.value as ChildProcess;
    expect(child.signalCode).toBe('SIGKILL');
  }, 9000);
});
