import { execFile, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FixedWindowsRunner, type FixedWindowsOperation } from './fixed-windows-runner.js';
import { WindowsIntegrationError } from './windows-integration-error.js';
import { WindowsOpenService } from './windows-open-service.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

let directory: string;
let converted: string;
let linuxResult: string;
let conversions: { direction: string; path: string }[];

function runner() {
  return new FixedWindowsRunner({
    async toLinux(path: string) {
      conversions.push({ direction: 'linux', path });
      return linuxResult;
    },
    async toWindows(path: string) {
      conversions.push({ direction: 'windows', path });
      return converted;
    },
  });
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'gram-windows-runner-'));
  linuxResult = directory;
  converted = 'r:\\Resolved\\한글 directory';
  conversions = [];
  vi.mocked(execFile).mockReset();
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const callback = args[3] as (error: Error | null, stdout: string, stderr: string) => void;
    callback(null, '', '');
    return {} as ChildProcess;
  });
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('FixedWindowsRunner invocation construction', () => {
  it('resolves and checks a directory before opening its canonical Windows path', async () => {
    await runner().run({ kind: 'OPEN_PATH', windowsPath: 'Q:\\input directory' });
    expect(conversions).toEqual([
      { direction: 'linux', path: 'Q:\\input directory' },
      { direction: 'windows', path: await realpath(directory) },
    ]);
    expect(execFile).toHaveBeenCalledExactlyOnceWith(
      'explorer.exe',
      [converted + '\\'],
      { shell: false, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 65536 },
      expect.any(Function),
    );
  });

  it('does not add another separator to an already directory-framed result', async () => {
    converted = 'q:\\';
    await runner().run({ kind: 'OPEN_PATH', windowsPath: 'Q:\\' });
    expect(vi.mocked(execFile).mock.calls[0]?.[1]).toEqual(['q:\\']);
  });

  it('resolves symlink directories before requesting the final Windows mapping', async () => {
    const target = join(directory, 'resolved');
    await mkdir(target);
    linuxResult = join(directory, 'link');
    await symlink(target, linuxResult);
    await runner().run({ kind: 'OPEN_PATH', windowsPath: 'Q:\\link' });
    expect(conversions[1]).toEqual({ direction: 'windows', path: await realpath(target) });
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it.each([
    'Q:\\한글 🧵 spaced file.txt',
    "q:\\'quote'; & $(literal) ^ file.txt",
    '\\\\wsl.localhost\\Custom-Distro\\home\\another\\file.txt',
    '\\\\server\\share name\\program.exe',
    'Q:\\' + '한'.repeat(8189),
  ])('keeps the fixed reveal switch separate from literal path %s', async (windowsPath) => {
    await runner().run({ kind: 'REVEAL_PATH', windowsPath });
    expect(execFile).toHaveBeenCalledExactlyOnceWith(
      'explorer.exe',
      ['/select,', windowsPath],
      { shell: false, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 65536 },
      expect.any(Function),
    );
    expect(conversions).toEqual([]);
  });

  it('opens only a serialized HTTP(S) URL without invoking a path converter', async () => {
    await runner().run({ kind: 'OPEN_URL', url: 'HTTPS://Example.TEST/한글?q=one&data=$(literal);x' });
    expect(execFile).toHaveBeenCalledExactlyOnceWith(
      'explorer.exe',
      ['https://example.test/%ED%95%9C%EA%B8%80?q=one&data=$(literal);x'],
      { shell: false, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 65536 },
      expect.any(Function),
    );
    expect(conversions).toEqual([]);
  });

  it('snapshots operation data before awaiting directory resolution', async () => {
    let release: (path: string) => void = () => {};
    const fixed = new FixedWindowsRunner({
      toLinux: () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
      async toWindows() {
        return converted;
      },
    });
    const operation = { kind: 'OPEN_PATH', windowsPath: 'Q:\\original', url: undefined } as Record<string, unknown>;
    delete operation.url;
    const pending = fixed.run(operation as FixedWindowsOperation);
    operation.kind = 'OPEN_URL';
    operation.windowsPath = '/root,Q:\\payload.exe';
    operation.url = 'file:///Q:/payload.exe';
    release(directory);
    await pending;
    expect(vi.mocked(execFile).mock.calls[0]?.[1]).toEqual([converted + '\\']);
  });
});

describe('FixedWindowsRunner strict operation boundary', () => {
  it.each([
    null,
    undefined,
    'explorer.exe',
    [],
    {},
    { kind: 'EXEC', command: 'calc.exe' },
    { kind: 'open_path', windowsPath: 'Q:\\folder' },
    { kind: 'OPEN_PATH', path: 'Q:\\folder' },
    { kind: 'OPEN_PATH', windowsPath: 17 },
    { kind: 'OPEN_URL', windowsPath: 'Q:\\folder' },
    { kind: 'REVEAL_PATH', url: 'https://example.test/' },
    ...['command', 'executable', 'script', 'args', 'shell', 'cwd', 'env', 'verb', 'flags'].map((key) => ({
      kind: 'REVEAL_PATH',
      windowsPath: 'Q:\\folder',
      [key]: 'untrusted',
    })),
    { kind: 'OPEN_URL', url: 'https://example.test/', windowsPath: 'Q:\\folder' },
    Object.assign(Object.create({ command: 'calc.exe' }) as object, { kind: 'REVEAL_PATH', windowsPath: 'Q:\\folder' }),
    { kind: 'REVEAL_PATH', windowsPath: 'Q:\\folder', [Symbol('script')]: 'untrusted' },
  ])('rejects a non-exact operation shape before side effects: %j', async (operation) => {
    await expect(runner().run(operation as FixedWindowsOperation)).rejects.toMatchObject({
      name: 'WindowsIntegrationError',
    });
    expect(execFile).not.toHaveBeenCalled();
    expect(conversions).toEqual([]);
  });

  it('rejects accessor data without invoking a getter', async () => {
    const getter = vi.fn(() => 'Q:\\folder');
    const operation = { kind: 'REVEAL_PATH' };
    Object.defineProperty(operation, 'windowsPath', { enumerable: true, get: getter });
    await expect(runner().run(operation as FixedWindowsOperation)).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
    expect(getter).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });

  it('accepts an exact null-prototype data record', async () => {
    const operation = Object.assign(Object.create(null) as object, {
      kind: 'REVEAL_PATH',
      windowsPath: 'Q:\\file.txt',
    });
    await runner().run(operation as FixedWindowsOperation);
    expect(vi.mocked(execFile).mock.calls[0]?.[1]).toEqual(['/select,', 'Q:\\file.txt']);
  });

  it('sanitizes a reflective failure on a malformed runtime object', async () => {
    const ownKeys = vi.fn(() => { throw new Error('private object details'); });
    const operation = new Proxy({ kind: 'REVEAL_PATH', windowsPath: 'Q:\\file.txt' }, { ownKeys });
    const error: unknown = await runner()
      .run(operation as FixedWindowsOperation)
      .catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: 'INVALID_OPERATION' });
    expect(String(error)).not.toContain('private object details');
    expect(ownKeys).toHaveBeenCalledTimes(1);
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe('FixedWindowsRunner path boundary cannot be bypassed directly', () => {
  it.each([
    '/select,Q:\\file',
    '/root,Q:\\file',
    '-Embedding',
    '/idlist,:payload',
    '--',
    'relative',
    'Q:relative',
    'Q:\\\\',
    '\\root-relative',
    'Q:/folder',
    '\\\\server',
    '\\\\server\\',
    '\\\\?\\Q:\\folder',
    '\\\\.\\pipe\\name',
    '\\??\\Q:\\file',
    'shell:AppsFolder',
    '::{01234567-0123-0123-0123-012345678901}',
    'file:///Q:/payload.exe',
    'ms-settings:display',
    'javascript:alert(1)',
    'Q:\\x,/root,Q:\\payload.exe',
    'Q:\\x" /root,Q:\\payload.exe',
    'Q:\\%COMSPEC%',
    'Q:\\x|y',
    'Q:\\x<y',
    'Q:\\x>y',
    'Q:\\x?y',
    'Q:\\x*y',
    'Q:\\file:stream',
    'Q:\\x\tname',
    'Q:\\x\u007f',
    'Q:\\x\n',
    'Q:\\x\0',
    'Q:\\x\ud800',
    'Q:\\x\udc00',
    'Q:\\' + 'x'.repeat(8190),
    'Q:\\a\\..\\file',
    'Q:\\.\\file',
    'Q:\\a\\\\file',
    'Q:\\trailing.',
    'Q:\\trailing ',
    'Q:\\CON',
    'Q:\\nul.txt',
    'Q:\\LPT1',
    'Q:\\COM¹.txt',
    'Q:\\lpt².log',
    'Q:\\CONIN$',
    'Q:\\conout$.txt',
    'Q:\\folder.{01234567-0123-0123-0123-012345678901}',
  ])('rejects %j with no process or conversion', async (windowsPath) => {
    await expect(runner().run({ kind: 'REVEAL_PATH', windowsPath })).rejects.toMatchObject({ code: 'INVALID_PATH' });
    expect(execFile).not.toHaveBeenCalled();
    expect(conversions).toEqual([]);
  });

  it.each([
    'file:///Q:/payload.exe',
    'javascript:alert(1)',
    'shell:AppsFolder',
    'ms-settings:display',
    'custom://example.test/',
    ' https://example.test/',
    'https://example.test/\n',
    'https://example.test/,/root,Q:\\payload.exe',
    'https://example.test/"x"',
    'https://example.test/\\x',
    'https://user:secret@example.test/',
    'https:///example.test/',
  ])('rejects URL %j directly at the runner', async (url) => {
    await expect(runner().run({ kind: 'OPEN_URL', url })).rejects.toMatchObject({ code: 'INVALID_URL' });
    expect(execFile).not.toHaveBeenCalled();
    expect(conversions).toEqual([]);
  });
});

describe('FixedWindowsRunner directory and failure boundaries', () => {
  it.each([
    'program.exe',
    'program.com',
    'script.ps1',
    'script.cmd',
    'script.bat',
    'shortcut.lnk',
    'link.url',
    'data.txt',
  ])('refuses to open the regular file %s even though Explorer is fixed', async (filename) => {
    linuxResult = join(directory, filename);
    await writeFile(linuxResult, 'fixture data');
    await expect(runner().run({ kind: 'OPEN_PATH', windowsPath: 'Q:\\' + filename })).rejects.toMatchObject({
      code: 'NOT_DIRECTORY',
    });
    expect(conversions).toHaveLength(1);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('refuses a symlink resolving to a regular file', async () => {
    const file = join(directory, 'script.ps1');
    await writeFile(file, 'fixture data');
    linuxResult = join(directory, 'link');
    await symlink(file, linuxResult);
    await expect(runner().run({ kind: 'OPEN_PATH', windowsPath: 'Q:\\link' })).rejects.toMatchObject({
      code: 'NOT_DIRECTORY',
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('fails closed on a missing directory without returning native path details', async () => {
    linuxResult = join(directory, 'private-missing');
    const error: unknown = await runner()
      .run({ kind: 'OPEN_PATH', windowsPath: 'Q:\\missing' })
      .catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: 'OPERATION_FAILED' });
    expect(String(error)).not.toContain(linuxResult);
    expect(error).not.toHaveProperty('cause');
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each(['relative', '', '//ambiguous/share', '/path\n', '/path\0', '/path\ud800'])(
    'rejects malformed Linux conversion %j before filesystem resolution',
    async (path) => {
      linuxResult = path;
      await expect(runner().run({ kind: 'OPEN_PATH', windowsPath: 'Q:\\folder' })).rejects.toMatchObject({
        code: 'INVALID_PATH',
      });
      expect(execFile).not.toHaveBeenCalled();
    },
  );

  it.each([
    '/root,Q:\\payload.exe',
    'relative',
    'shell:AppsFolder',
    'Q:\\x,/root,Q:\\payload.exe',
    'Q:\\x"',
    'Q:\\x\0',
  ])('revalidates the canonical conversion result %j before spawning', async (path) => {
    converted = path;
    await expect(runner().run({ kind: 'OPEN_PATH', windowsPath: 'Q:\\folder' })).rejects.toMatchObject({
      code: 'INVALID_PATH',
    });
    expect(conversions).toHaveLength(2);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('checks the final length after adding directory framing', async () => {
    converted = 'Q:\\' + 'x'.repeat(8189);
    await expect(runner().run({ kind: 'OPEN_PATH', windowsPath: 'Q:\\folder' })).rejects.toMatchObject({
      code: 'INVALID_PATH',
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each(['toLinux', 'toWindows'] as const)('does not spawn after a %s failure', async (method) => {
    const paths = {
      async toLinux() {
        return directory;
      },
      async toWindows() {
        return converted;
      },
    };
    paths[method] = () => {
      throw new Error('private conversion details');
    };
    const error: unknown = await new FixedWindowsRunner(paths)
      .run({ kind: 'OPEN_PATH', windowsPath: 'Q:\\folder' })
      .catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: 'OPERATION_FAILED' });
    expect(String(error)).not.toContain('private conversion details');
    expect(error).not.toHaveProperty('cause');
    expect(execFile).not.toHaveBeenCalled();
  });

  it('treats exit 1 as failure without retrying or exposing process details', async () => {
    const raw = Object.assign(new Error('private URL and stderr'), { code: 1, stderr: 'private stderr' });
    vi.mocked(execFile).mockImplementationOnce((...args: unknown[]) => {
      (args[3] as (error: Error) => void)(raw);
      return {} as ChildProcess;
    });
    const error: unknown = await runner()
      .run({ kind: 'OPEN_URL', url: 'https://example.test/?private=value' })
      .catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: 'OPERATION_FAILED' });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(String(error)).not.toContain('private');
    expect(error).not.toHaveProperty('cause');
    expect(error).not.toHaveProperty('stderr');
  });

  it('preserves a fixed error code across a service without retaining extra details', async () => {
    const raw = Object.assign(new WindowsIntegrationError('NOT_DIRECTORY'), { stderr: 'private details' });
    raw.message = 'private path';
    const service = new WindowsOpenService({
      async run() {
        throw raw;
      },
    });
    const error: unknown = await service.openPath('Q:\\data.txt').catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      name: 'WindowsIntegrationError',
      code: 'NOT_DIRECTORY',
      message: 'Windows path opening requires an existing directory.',
    });
    expect(error).not.toHaveProperty('stderr');
    expect(error).not.toHaveProperty('cause');
    expect(error).not.toBe(raw);
  });
});
