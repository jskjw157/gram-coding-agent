import { execFile, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WindowsOpenService, WindowsRevealService } from './index.js';

// Observe calls while executing real child processes; these fixtures are not Windows.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

const explorerSource = [
  "const fs = require('node:fs');",
  'fs.writeFileSync(process.env.GRAM_OPEN_CAPTURE, JSON.stringify(process.argv.slice(2)));',
  'const mode = process.env.GRAM_OPEN_MODE;',
  "if (mode === 'nonzero') {",
  "  process.stderr.write('private stderr: ' + process.argv[2]);",
  '  process.exitCode = 1;',
  "} else if (mode === 'signal') {",
  "  process.kill(process.pid, 'SIGTERM');",
  "} else if (mode === 'stdout-overflow') {",
  "  process.stdout.write('x'.repeat(65537));",
  "} else if (mode === 'stderr-overflow') {",
  "  process.stderr.write('x'.repeat(65537));",
  "} else if (mode === 'hang') {",
  "  process.on('SIGTERM', () => {});",
  '  setInterval(() => {}, 1000);',
  '}',
].join('\n');

const converterSource = [
  "process.stdout.write((process.argv[2] === '-u' ? process.env.GRAM_OPEN_LINUX : process.env.GRAM_OPEN_WINDOWS) + '\\n');",
].join('\n');

describe.runIf(process.platform === 'linux')('fixed Windows runner via real Linux fixture processes', () => {
  let directory: string;
  let capture: string;
  let linuxDirectory: string;
  let marker: string;
  const windowsDirectory = 'r:\\Resolved\\한글 directory';

  beforeEach(() => {
    vi.mocked(execFile).mockClear();
    directory = mkdtempSync(join(tmpdir(), 'gram-windows-process-'));
    capture = join(directory, 'explorer-argv.json');
    linuxDirectory = join(directory, '한글 directory');
    marker = join(process.cwd(), basename(directory) + '-injected');
    mkdirSync(linuxDirectory);
    writeFileSync(join(directory, 'explorer.exe'), '#!' + process.execPath + '\n' + explorerSource, { mode: 0o700 });
    writeFileSync(join(directory, 'wslpath'), '#!' + process.execPath + '\n' + converterSource, { mode: 0o700 });
    vi.stubEnv('PATH', directory);
    vi.stubEnv('GRAM_OPEN_CAPTURE', capture);
    vi.stubEnv('GRAM_OPEN_MODE', 'success');
    vi.stubEnv('GRAM_OPEN_LINUX', linuxDirectory);
    vi.stubEnv('GRAM_OPEN_WINDOWS', windowsDirectory);
  });

  afterEach(() => {
    for (const result of vi.mocked(execFile).mock.results) {
      if (result.type !== 'return') continue;
      const child = result.value as ChildProcess;
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    vi.unstubAllEnvs();
    rmSync(marker, { force: true });
    rmSync(directory, { recursive: true, force: true });
  });

  it('reveals one literal path with a separate fixed switch and no shell evaluation', async () => {
    // Backslashes are Windows path data. If a shell were introduced, this also contains shell syntax.
    const windowsPath = "Q:\\한글 'single'; $(touch " + basename(marker) + ') & literal.txt';
    await new WindowsRevealService().revealPath(windowsPath);
    expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual(['/select,', windowsPath]);
    expect(existsSync(marker)).toBe(false);
    expect(execFile).toHaveBeenCalledExactlyOnceWith(
      'explorer.exe',
      ['/select,', windowsPath],
      { shell: false, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 65536 },
      expect.any(Function),
    );
  });

  it('submits only the normalized URL as one argument through the default service', async () => {
    await new WindowsOpenService().openUrl('HTTPS://Example.TEST/한글?q=one&other=two');
    expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual([
      'https://example.test/%ED%95%9C%EA%B8%80?q=one&other=two',
    ]);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('uses the default converter and real directory check before one Explorer invocation', async () => {
    await new WindowsOpenService().openPath('Q:\\original');
    expect(vi.mocked(execFile).mock.calls.map((call) => [call[0], call[1]])).toEqual([
      ['wslpath', ['-u', 'Q:\\original']],
      ['wslpath', ['-w', linuxDirectory]],
      ['explorer.exe', [windowsDirectory + '\\']],
    ]);
    expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual([windowsDirectory + '\\']);
  });

  it('refuses a real regular file through the default service before starting Explorer', async () => {
    const file = join(directory, 'program.exe');
    writeFileSync(file, 'fixture bytes');
    vi.stubEnv('GRAM_OPEN_LINUX', file);
    await expect(new WindowsOpenService().openPath('Q:\\program.exe')).rejects.toMatchObject({
      code: 'NOT_DIRECTORY',
    });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(vi.mocked(execFile).mock.calls[0]?.[0]).toBe('wslpath');
    expect(existsSync(capture)).toBe(false);
  });

  it('fails when the installed Explorer executable is absent without falling back', async () => {
    rmSync(join(directory, 'explorer.exe'));
    await expect(new WindowsRevealService().revealPath('Q:\\file.txt')).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
    });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(existsSync(capture)).toBe(false);
  });

  it('fails when wslpath is absent before attempting directory opening', async () => {
    rmSync(join(directory, 'wslpath'));
    await expect(new WindowsOpenService().openPath('Q:\\folder')).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
    });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(vi.mocked(execFile).mock.calls[0]?.[0]).toBe('wslpath');
    expect(existsSync(capture)).toBe(false);
  });

  it.each(['nonzero', 'signal', 'stdout-overflow', 'stderr-overflow'])(
    'reports %s safely without retrying the requested action',
    async (mode) => {
      vi.stubEnv('GRAM_OPEN_MODE', mode);
      const url = 'https://example.test/?private=value';
      const error: unknown = await new WindowsOpenService().openUrl(url).catch((cause: unknown) => cause);
      expect(error).toMatchObject({ name: 'WindowsIntegrationError', code: 'OPERATION_FAILED' });
      expect(execFile).toHaveBeenCalledTimes(1);
      expect(String(error)).not.toContain(url);
      expect(String(error)).not.toContain('private stderr');
      expect(error).not.toHaveProperty('cause');
      expect(error).not.toHaveProperty('stdout');
      expect(error).not.toHaveProperty('stderr');
    },
  );

  it('kills a stuck launcher at the bounded timeout even if it ignores SIGTERM', async () => {
    vi.stubEnv('GRAM_OPEN_MODE', 'hang');
    const started = performance.now();
    await expect(new WindowsOpenService().openUrl('https://example.test/')).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
    });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual(['https://example.test/']);
    expect(performance.now() - started).toBeLessThan(8000);
    const child = vi.mocked(execFile).mock.results[0]?.value as ChildProcess;
    expect(child.signalCode).toBe('SIGKILL');
  }, 9000);
});
