import { execFile, spawn } from 'node:child_process';
import { rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  FixedWindowsRunner,
  WindowsClipboardService,
  WindowsOpenService,
  WindowsPathService,
  WindowsRevealService,
  type FixedWindowsOperation,
  type WindowsClipboardOptions,
} from '@gram/windows-integration';
import { SecretRedactor } from '@gram/secrets';
import {
  normalizeExecutableCommand,
  normalizeShellCommand,
  PolicyEngine,
  UnsupportedShellSyntaxError,
} from '@gram/policy';
import {
  actualChildren,
  createWindowsFixture,
  expectPrivateEqual,
  marker,
  observeParentSinks,
  privateCanary,
  safeFailure,
  type NativeMode,
  type NativeRole,
} from './windows-escape.fixture.js';

// Record options while retaining real Node child processes, pipes and deadlines.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(actual.execFile), spawn: vi.fn(actual.spawn) };
});

beforeAll(() => {
  // A missing prerequisite is a failing run, not an empty/skip-based success.
  expect(process.platform, 'This suite requires Linux transport fixtures; Windows native is NOT_RUN.').toBe('linux');
});

let fixture: ReturnType<typeof createWindowsFixture>;
beforeEach(() => {
  fixture = createWindowsFixture();
});
afterEach(() => {
  fixture.cleanup();
});

function expectExecBoundary(expected: { role: NativeRole; args: string[] }[]): void {
  expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  expect(vi.mocked(execFile)).toHaveBeenCalledTimes(expected.length);
  for (const [index, call] of vi.mocked(execFile).mock.calls.entries()) {
    expect(call[0]).toBe(expected[index]?.role);
    expect(call[1]).toEqual(expected[index]?.args);
    expect(call[2]).toEqual({
      shell: false,
      encoding: 'utf8',
      timeout: 5000,
      killSignal: 'SIGKILL',
      maxBuffer: 65536,
    });
  }
  // A pass-through spy alone is insufficient: the Linux processes must see the same argv.
  expect(fixture.calls().map(({ role, args }) => ({ role, args }))).toEqual(expected);
}

function expectClipboardBoundary(count: number): string[][] {
  expect(vi.mocked(execFile)).not.toHaveBeenCalled();
  expect(vi.mocked(spawn)).toHaveBeenCalledTimes(count);
  const calls = fixture.calls();
  expect(calls).toHaveLength(count);
  for (const [index, call] of vi.mocked(spawn).mock.calls.entries()) {
    expect(call[0]).toBe('powershell.exe');
    const args = call[1] as string[];
    expect(args).toHaveLength(6);
    expect(args.slice(0, 5)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand']);
    expect(args[5]).toMatch(/^[A-Za-z0-9+/]+={0,2}$/u);
    expect(call[2]).toEqual({
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 5000,
      killSignal: 'SIGKILL',
      env: expect.any(Object),
    });
    const options = call[2] as { env: Record<string, string> };
    expect(
      Object.keys(options.env).every((key) =>
        ['PATH', 'WSL_INTEROP', 'WSL_DISTRO_NAME', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'].includes(key),
      ),
    ).toBe(true);
    expect(options.env).not.toHaveProperty('GRAM_WINDOWS_ESCAPE_CANARY');
    expect(options.env).not.toHaveProperty('WSLENV');
    expect(calls[index]).toMatchObject({ role: 'powershell.exe', args });
    expect(calls[index]?.environment).toEqual({});
  }
  return calls.map((call) => call.args);
}

function expectNoExecution(): void {
  expect(execFile).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
  expect(fixture.calls()).toEqual([]);
}

describe('Windows public-boundary historical security regressions', () => {
  it.each([
    {
      label: 'registered value inside OpenAI-shaped token',
      text: 'sk-abINNERfixtureSECRETlongTOKENsuffix0123456789',
      secrets: ['INNERfixtureSECRET'],
      nativeCalls: 1,
    },
    {
      label: 'registered value across token start',
      text: 'prefix sk-abcLONGfixtureTOKENsuffix0123456789',
      secrets: ['prefix sk-abc'],
      nativeCalls: 1,
    },
    {
      label: 'partially overlapping registrations',
      text: 'abcdefghijklmnopqrstuvwxyz0123456789',
      secrets: ['abcdefghijklmnopqrst', 'tuvwxyz0123456789'],
      nativeCalls: 1,
    },
    {
      label: 'registered Bearer selector',
      text: 'Authorization: Bearer opaque-fixture-private-value',
      secrets: ['Authorization: Bearer'],
      nativeCalls: 0,
    },
    {
      label: 'registered PEM header only',
      text: '-----BEGIN PRIVATE KEY-----\nsynthetic-body\n-----END PRIVATE KEY-----',
      secrets: ['-----BEGIN PRIVATE KEY-----'],
      nativeCalls: 1,
    },
  ])('refuses a secret fragment after $label is partially consumed', async ({ text, secrets, nativeCalls }) => {
    fixture.configure('powershell.exe', 'bytes', Buffer.from(text));
    await safeFailure(fixture.clipboard(secrets).readText(), 'REDACTION_FAILED', [text]);
    expect(fixture.calls()).toHaveLength(nativeCalls);
    expectPrivateEqual(fixture.events, [
      { operation: 'READ', result: 'FAILURE', characterCount: nativeCalls ? text.length : null },
    ]);
  });

  it('still masks a complete registered value containing overlapping secrets', async () => {
    const text = 'abcdefghijklmnopqrstuvwxyz0123456789';
    fixture.configure('powershell.exe', 'bytes', Buffer.from(text));
    expectPrivateEqual(await fixture.clipboard([text, 'abcdefghijklmnopqrst', 'tuvwxyz0123456789']).readText(), {
      text: marker,
      redacted: true,
    });
  });

  it('bounds clipboard completion after the direct child exits with inherited pipes open', async () => {
    fixture.configure('powershell.exe', 'exited-with-pipes');
    const started = performance.now();
    await safeFailure(fixture.clipboard().readText(), 'CLIPBOARD_FAILED');
    expect(performance.now() - started).toBeLessThan(7000);
    expect(fixture.calls()).toHaveLength(1);
  });

  it('rejects clipboard stderr promptly even when a descendant retains its pipes', async () => {
    fixture.configure('powershell.exe', 'stderr-with-pipes');
    const started = performance.now();
    await safeFailure(fixture.clipboard().readText(), 'CLIPBOARD_FAILED', [privateCanary]);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(fixture.calls()).toHaveLength(1);
  });
});

describe('WindowsPathService direct argv and validation', () => {
  it.each([
    { label: 'spaces and Korean', part: 'space 한글 이름' },
    { label: 'paired Unicode', part: 'emoji 😀' },
    { label: 'double quote', part: 'a"b' },
    { label: 'apostrophe', part: "a'b" },
    { label: 'semicolon', part: 'a; whoami' },
    { label: 'ampersand', part: 'a & whoami' },
    { label: 'pipe', part: 'a | whoami' },
    { label: 'dollar substitution', part: '$(whoami)' },
    { label: 'PowerShell subexpression', part: '$([System.Environment]::UserName)' },
    { label: 'environment expansion syntax', part: '%COMSPEC%' },
    { label: 'backtick', part: 'literal `whoami`' },
    { label: 'tab data', part: 'a\tb' },
  ])('keeps $label literal in both conversion directions', async ({ part }) => {
    const linux = '/mnt/synthetic/' + part;
    const windows = 'R:\\synthetic\\' + part;
    fixture.configure('wslpath', 'success', undefined, { linuxPath: linux, windowsPath: windows });
    const paths = new WindowsPathService();
    expect(await paths.toWindows(linux)).toBe(windows);
    expect(await paths.toLinux(windows)).toBe(linux);
    expectExecBoundary([
      { role: 'wslpath', args: ['-w', linux] },
      { role: 'wslpath', args: ['-u', windows] },
    ]);
  });

  it('passes an arbitrary UNC server and share as one conversion argument', async () => {
    const windows = '\\\\fixture-server\\fixture-share\\한글 & $(whoami)';
    expect(await new WindowsPathService().toLinux(windows)).toBe(fixture.directory);
    expectExecBoundary([{ role: 'wslpath', args: ['-u', windows] }]);
  });

  it.each([
    { label: 'empty', value: '' },
    { label: 'blank', value: ' \t ' },
    { label: 'NUL', value: '/tmp/a\0b' },
    { label: 'line feed', value: '/tmp/a\nwhoami' },
    { label: 'carriage return', value: '/tmp/a\rwhoami' },
    { label: 'high surrogate', value: '/tmp/\ud800' },
    { label: 'low surrogate', value: '/tmp/\udfff' },
    { label: 'over length', value: '/' + 'a'.repeat(8192) },
    { label: 'option', value: '--help' },
    { label: 'conversion switch', value: '-u' },
    { label: 'number', value: 7 },
    { label: 'null', value: null },
    { label: 'array', value: ['/tmp/path'] },
    { label: 'execution object', value: { path: '/tmp/path', executable: 'cmd.exe', shell: true } },
  ])('rejects $label before starting either conversion', async ({ value }) => {
    const paths = new WindowsPathService();
    await safeFailure(paths.toWindows(value as string), 'INVALID_PATH');
    await safeFailure(paths.toLinux(value as string), 'INVALID_PATH');
    expectNoExecution();
  });

  it('never coerces an object into a path', async () => {
    const coerce = vi.fn(() => privateCanary);
    const value = { [Symbol.toPrimitive]: coerce, toString: coerce };
    await safeFailure(new WindowsPathService().toWindows(value as unknown as string), 'INVALID_PATH');
    expect(coerce).not.toHaveBeenCalled();
    expectNoExecution();
  });

  it('accepts exactly 8192 code units without turning any portion into an option', async () => {
    const value = '/' + 'x'.repeat(8191);
    await new WindowsPathService().toWindows(value);
    expectExecBoundary([{ role: 'wslpath', args: ['-w', value] }]);
  });

  it.each([
    { label: 'empty', bytes: Buffer.alloc(0) },
    { label: 'blank', bytes: Buffer.from('  \n') },
    { label: 'multiple lines', bytes: Buffer.from('/safe\n/private\n') },
    { label: 'two terminal newlines', bytes: Buffer.from('/safe\n\n') },
    { label: 'NUL', bytes: Buffer.from('/safe\0private') },
    { label: 'carriage return', bytes: Buffer.from('/safe\rprivate') },
    { label: 'over length', bytes: Buffer.from('/' + 'x'.repeat(8192)) },
  ])('rejects $label from an otherwise successful wslpath process', async ({ bytes }) => {
    fixture.configure('wslpath', 'bytes', bytes);
    await safeFailure(new WindowsPathService().toLinux('R:\\private-path'), 'INVALID_OUTPUT', ['private-path']);
    expect(fixture.calls()).toHaveLength(1);
  });

  it.each(['\n', '\r\n'])('removes only the native line terminator %j', async (terminator) => {
    const output = '  /path with literal whitespace \t ';
    fixture.configure('wslpath', 'bytes', Buffer.from(output + terminator));
    expect(await new WindowsPathService().toLinux('R:\\path')).toBe(output);
  });
});

describe('WindowsOpenService and WindowsRevealService Explorer boundaries', () => {
  it.each([
    { label: 'spaces and Korean', path: 'R:\\space 한글\\directory' },
    { label: 'paired Unicode', path: 'R:\\emoji 😀' },
    { label: 'apostrophe', path: "R:\\apostrophe'folder" },
    { label: 'semicolon', path: 'R:\\a; whoami' },
    { label: 'ampersand', path: 'R:\\a & whoami' },
    { label: 'PowerShell subexpression', path: 'R:\\$(Get-Date)' },
    { label: 'PowerShell invocation syntax', path: 'R:\\$(& whoami)' },
    { label: 'backtick', path: 'R:\\literal `whoami`' },
    { label: 'UNC', path: '\\\\fixture-server\\fixture-share\\한글 & data' },
  ])('keeps $label inside a target argument after the real directory check', async ({ path }) => {
    fixture.configure('wslpath', 'success', undefined, { windowsPath: path });
    await new WindowsOpenService().openPath(path);
    await new WindowsRevealService().revealPath(path);
    expectExecBoundary([
      { role: 'wslpath', args: ['-u', path] },
      { role: 'wslpath', args: ['-w', fixture.directory] },
      { role: 'explorer.exe', args: [path + '\\'] },
      { role: 'explorer.exe', args: ['/select,', path] },
    ]);
  });

  it.each([
    { label: 'leading option', path: '/select,R:\\private' },
    { label: 'switch-like relative name', path: '-Embedding' },
    { label: 'double quote', path: 'R:\\a" /select,secret' },
    { label: 'pipe', path: 'R:\\a | whoami' },
    { label: 'environment expansion', path: 'R:\\%COMSPEC%' },
    { label: 'Explorer comma separator', path: 'R:\\a,/root' },
    { label: 'line feed', path: 'R:\\a\nwhoami' },
    { label: 'carriage return', path: 'R:\\a\rwhoami' },
    { label: 'NUL', path: 'R:\\a\0b' },
    { label: 'unpaired Unicode', path: 'R:\\a\ud800' },
    { label: 'tab control', path: 'R:\\a\tb' },
    { label: 'relative drive', path: 'R:private' },
    { label: 'relative path', path: 'private\\directory' },
    { label: 'forward slash', path: 'R:/private' },
    { label: 'alternate data stream', path: 'R:\\file:script' },
    { label: 'device namespace', path: '\\\\?\\R:\\private' },
    { label: 'Win32 device', path: '\\\\.\\pipe\\private' },
    { label: 'missing UNC share', path: '\\\\server' },
    { label: 'dot traversal', path: '\\\\server\\share\\..\\private' },
    { label: 'reserved DOS name', path: 'R:\\CON.txt' },
    { label: 'trailing dot', path: 'R:\\folder.' },
    { label: 'trailing space', path: 'R:\\folder ' },
    { label: 'CLSID suffix', path: 'R:\\folder.{20d04fe0-3aea-1069-a2d8-08002b30309d}' },
    { label: 'over length', path: 'R:\\' + 'x'.repeat(8190) },
  ])('rejects $label before conversion or Explorer launch', async ({ path }) => {
    await safeFailure(new WindowsOpenService().openPath(path), 'INVALID_PATH', [path]);
    await safeFailure(new WindowsRevealService().revealPath(path), 'INVALID_PATH', [path]);
    expectNoExecution();
  });

  it.each([
    { label: 'regular file', link: false },
    { label: 'symlink to a file', link: true },
  ])('refuses to open a $label as a directory', async ({ link }) => {
    const file = join(fixture.root, 'private-file.txt');
    writeFileSync(file, privateCanary);
    const target = link ? join(fixture.root, 'private-file-link') : file;
    if (link) symlinkSync(file, target);
    fixture.configure('wslpath', 'success', undefined, { linuxPath: target });
    await safeFailure(new WindowsOpenService().openPath(fixture.windowsPath), 'NOT_DIRECTORY', [file, target]);
    expectExecBoundary([{ role: 'wslpath', args: ['-u', fixture.windowsPath] }]);
  });

  it('does not launch Explorer after a private directory lookup fails', async () => {
    const missing = join(fixture.root, privateCanary);
    fixture.configure('wslpath', 'success', undefined, { linuxPath: missing });
    await safeFailure(new WindowsOpenService().openPath(fixture.windowsPath), 'OPERATION_FAILED', [missing]);
    expectExecBoundary([{ role: 'wslpath', args: ['-u', fixture.windowsPath] }]);
  });

  it.each([
    { label: 'relative converted path', output: 'relative/directory' },
    { label: 'double slash converted path', output: '//server/private' },
  ])('rejects a $label before filesystem or Explorer use', async ({ output }) => {
    fixture.configure('wslpath', 'success', undefined, { linuxPath: output });
    await safeFailure(new WindowsOpenService().openPath(fixture.windowsPath), 'INVALID_PATH');
    expectExecBoundary([{ role: 'wslpath', args: ['-u', fixture.windowsPath] }]);
  });

  it.each([
    { label: 'HTTP', input: 'http://example.test/', expected: 'http://example.test/' },
    { label: 'HTTPS normalization', input: 'HTTPS://Example.Test:443', expected: 'https://example.test/' },
    {
      label: 'encoded Korean',
      input: 'https://example.test/한글',
      expected: 'https://example.test/%ED%95%9C%EA%B8%80',
    },
    {
      label: 'metacharacter query',
      input: 'https://example.test/?q=$(whoami)&x=one;two|three',
      expected: 'https://example.test/?q=$(whoami)&x=one;two|three',
    },
    {
      label: 'encoded quote comma and newline data',
      input: 'https://example.test/%22%2C%0A',
      expected: 'https://example.test/%22%2C%0A',
    },
    {
      label: 'percent environment syntax as query data',
      input: 'https://example.test/?q=%COMSPEC%',
      expected: 'https://example.test/?q=%COMSPEC%',
    },
  ])('launches $label using exactly one fixed Explorer target', async ({ input, expected }) => {
    await new WindowsOpenService().openUrl(input);
    expectExecBoundary([{ role: 'explorer.exe', args: [expected] }]);
  });

  it.each([
    { label: 'file protocol', value: 'file:///R:/private' },
    { label: 'JavaScript protocol', value: 'javascript:alert(1)' },
    { label: 'shell protocol', value: 'shell:AppsFolder' },
    { label: 'settings protocol', value: 'ms-settings:privacy' },
    { label: 'arbitrary protocol', value: 'custom-command:payload' },
    { label: 'data protocol', value: 'data:text/plain,private' },
    { label: 'FTP protocol', value: 'ftp://example.test/private' },
    { label: 'protocol relative', value: '//example.test/path' },
    { label: 'missing authority', value: 'https:///path' },
    { label: 'missing hostname', value: 'https://' },
    { label: 'credentials', value: 'https://user:private@example.test/' },
    { label: 'empty credentials', value: 'https://@example.test/' },
    { label: 'backslash authority', value: 'https://example.test\\@attacker.test/' },
    { label: 'raw newline', value: 'https://example.test/\nwhoami' },
    { label: 'raw space', value: 'https://example.test/a b' },
    { label: 'NUL', value: 'https://example.test/\0' },
    { label: 'quote switch', value: 'https://example.test/"/select,R:\\private' },
    { label: 'raw comma', value: 'https://example.test/,/select,' },
    { label: 'encoded authority comma', value: 'https://one%2Ctwo.test/' },
    { label: 'Unicode authority comma', value: 'https://one，two.test/' },
    { label: 'malformed IPv6', value: 'https://[::1/' },
    { label: 'invalid port', value: 'https://example.test:65536/' },
    { label: 'unpaired Unicode', value: 'https://example.test/\udfff' },
    { label: 'over length', value: 'https://example.test/' + 'x'.repeat(8192) },
    {
      label: 'execution object',
      value: { url: 'https://example.test/', executable: 'cmd.exe', args: ['/c', 'whoami'] },
    },
  ])('rejects $label without starting any native process', async ({ value }) => {
    await safeFailure(new WindowsOpenService().openUrl(value as string), 'INVALID_URL');
    expectNoExecution();
  });
});

describe('FixedWindowsRunner exact request objects', () => {
  const fields = [
    { field: 'executable', value: 'cmd.exe' },
    { field: 'command', value: 'whoami' },
    { field: 'args', value: ['/c', 'whoami'] },
    { field: 'script', value: '$([System.Environment]::UserName)' },
    { field: 'shell', value: true },
    { field: 'cwd', value: '/private/cwd' },
    { field: 'env', value: { COMSPEC: 'cmd.exe', PATH: '/private/bin' } },
    { field: 'verb', value: 'runas' },
    { field: 'windowsVerbatimArguments', value: true },
  ];
  const kinds = ['OPEN_PATH', 'REVEAL_PATH', 'OPEN_URL'] as const;
  function operation(kind: (typeof kinds)[number]): FixedWindowsOperation {
    return kind === 'OPEN_URL' ? { kind, url: 'https://example.test/' } : { kind, windowsPath: fixture.windowsPath };
  }

  it.each(kinds.flatMap((kind) => fields.map((field) => ({ kind, ...field }))))(
    'rejects injected $field on $kind before execution',
    async ({ kind, field, value }) => {
      const request = { ...operation(kind), [field]: value };
      await safeFailure(new FixedWindowsRunner().run(request), 'INVALID_OPERATION');
      expectNoExecution();
    },
  );

  it.each([
    { label: 'null', make: () => null },
    { label: 'array', make: () => ['OPEN_URL', 'https://example.test/'] },
    { label: 'unknown kind', make: () => ({ kind: 'WINDOWS_EXEC', executable: 'cmd.exe' }) },
    { label: 'missing target', make: () => ({ kind: 'OPEN_URL' }) },
    { label: 'opposite target', make: () => ({ kind: 'OPEN_URL', windowsPath: 'R:\\private' }) },
    {
      label: 'custom prototype',
      make: () =>
        Object.create(
          { shell: true },
          {
            kind: { value: 'OPEN_URL', enumerable: true },
            url: { value: 'https://example.test/', enumerable: true },
          },
        ) as object,
    },
    {
      label: 'non-enumerable execution field',
      make: () => Object.defineProperty({ kind: 'OPEN_URL', url: 'https://example.test/' }, 'shell', { value: true }),
    },
    {
      label: 'symbol execution field',
      make: () => ({
        kind: 'OPEN_URL',
        url: 'https://example.test/',
        [Symbol('script')]: privateCanary,
      }),
    },
  ])('rejects a $label request', async ({ make }) => {
    await safeFailure(new FixedWindowsRunner().run(make() as FixedWindowsOperation), 'INVALID_OPERATION');
    expectNoExecution();
  });

  it.each(['kind', 'url', 'script'])('does not evaluate the %s accessor', async (field) => {
    const getter = vi.fn(() => {
      throw new Error(privateCanary);
    });
    const request = { kind: 'OPEN_URL', url: 'https://example.test/' };
    Object.defineProperty(request, field, { get: getter, enumerable: true });
    await safeFailure(new FixedWindowsRunner().run(request as FixedWindowsOperation), 'INVALID_OPERATION');
    expect(getter).not.toHaveBeenCalled();
    expectNoExecution();
  });

  it('sanitizes a proxy inspection failure', async () => {
    const request = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error(privateCanary);
        },
      },
    );
    await safeFailure(new FixedWindowsRunner().run(request as FixedWindowsOperation), 'INVALID_OPERATION');
    expectNoExecution();
  });

  it('accepts a null-prototype request with exactly the two data fields', async () => {
    const request: unknown = Object.assign(Object.create(null) as object, {
      kind: 'OPEN_URL',
      url: 'https://example.test/',
    });
    await new FixedWindowsRunner().run(request as FixedWindowsOperation);
    expectExecBoundary([{ role: 'explorer.exe', args: ['https://example.test/'] }]);
  });

  it('snapshots the validated request before asynchronous path conversion', async () => {
    const path = fixture.windowsPath;
    const request = { kind: 'OPEN_PATH', windowsPath: path } as FixedWindowsOperation & Record<string, unknown>;
    const running = new FixedWindowsRunner().run(request);
    Object.assign(request, { kind: 'OPEN_URL', windowsPath: 'R:\\%COMSPEC%', url: 'shell:AppsFolder', shell: true });
    await running;
    expectExecBoundary([
      { role: 'wslpath', args: ['-u', path] },
      { role: 'wslpath', args: ['-w', fixture.directory] },
      { role: 'explorer.exe', args: [path + '\\'] },
    ]);
  });
});

describe('WindowsClipboardService text data and fixed transport', () => {
  it.each([
    { label: 'empty value', text: '' },
    { label: 'whitespace', text: ' \t \r\n' },
    { label: 'Korean and paired Unicode', text: '공백 한글 😀' },
    { label: 'quotes', text: 'single \' and double "' },
    { label: 'semicolon', text: 'one; whoami; two' },
    { label: 'multiline', text: 'first\r\nsecond\nthird' },
    { label: 'ampersand', text: '& whoami &' },
    { label: 'pipe', text: 'one | whoami | two' },
    { label: 'dollar substitution', text: '$(whoami)' },
    { label: 'PowerShell subexpression', text: '$([System.Environment]::UserName)' },
    { label: 'environment expansion syntax', text: '%COMSPEC% /c whoami' },
    { label: 'UNC text', text: '\\\\server\\share\\data & $(whoami)' },
    { label: 'backtick', text: '`whoami`' },
    { label: 'leading BOM and replacement character data', text: '\ufeffliteral \ufffd' },
    { label: 'URI as clipboard data', text: 'file:///R:/private\njavascript:alert(1)\nms-settings:privacy' },
  ])('preserves $label as UTF-8 data without treating it as code', async ({ text }) => {
    const clipboard = fixture.clipboard();
    const observed = await observeParentSinks(async () => {
      await clipboard.writeText(text);
      expect(Buffer.compare(fixture.stdin(), Buffer.from(text))).toBe(0);
      fixture.configure('powershell.exe', 'bytes', Buffer.from(text));
      return clipboard.readText();
    });
    expectPrivateEqual(observed.value, { text, redacted: false });
    expect(Object.isFrozen(observed.value)).toBe(true);
    expect(observed.output.length === 0, 'Parent output must remain empty.').toBe(true);
    const args = expectClipboardBoundary(2);
    expect(args[0]).not.toEqual(args[1]); // fixed write vs. fixed read, never a request-chosen script
    expectPrivateEqual(fixture.events, [
      { operation: 'WRITE', result: 'SUCCESS', characterCount: text.length },
      { operation: 'READ', result: 'SUCCESS', characterCount: text.length },
    ]);
    expect(fixture.events.every(Object.isFrozen)).toBe(true);
  });

  it('uses identical executable and script argv for unrelated injection-shaped writes', async () => {
    const values = [
      privateCanary + '"; & whoami; #',
      privateCanary + '$(Get-Process)\r\n%COMSPEC% | cmd.exe',
      privateCanary + '`"; $([System.Environment]::UserName)',
    ];
    for (const text of values) {
      await fixture.clipboard().writeText(text);
      expect(Buffer.compare(fixture.stdin(), Buffer.from(text))).toBe(0);
    }
    const calls = expectClipboardBoundary(values.length);
    for (const args of calls) {
      expect(args).toEqual(calls[0]);
      const source = Buffer.from(args[5] ?? '', 'base64').toString('utf16le');
      expect(source.length).toBeGreaterThan(0);
      expect(source.includes(privateCanary)).toBe(false);
      for (const value of values) expect(args.some((arg) => arg.includes(value))).toBe(false);
    }
  });

  it('reassembles UTF-8 across actual one-byte stdout chunks', async () => {
    const text = '\ufeff한글 😀 \ufffd\r\n';
    fixture.configure('powershell.exe', 'chunked', Buffer.from(text));
    expectPrivateEqual(await fixture.clipboard().readText(), { text, redacted: false });
    expectClipboardBoundary(1);
  });

  it.each([
    { label: 'ASCII just below 1 MiB', text: 'a'.repeat(1048575) },
    { label: 'ASCII exactly 1 MiB', text: 'a'.repeat(1048576) },
    { label: 'Korean exactly 1 MiB', text: '한'.repeat(349525) + 'a' },
    { label: 'paired Unicode exactly 1 MiB', text: '😀'.repeat(262144) },
  ])('accepts $label in each direction', async ({ text }) => {
    const clipboard = fixture.clipboard();
    await clipboard.writeText(text);
    expect(Buffer.compare(fixture.stdin(), Buffer.from(text))).toBe(0);
    fixture.configure('powershell.exe', 'bytes', Buffer.from(text));
    const result = await clipboard.readText();
    // Boolean comparisons keep megabyte payloads out of a failing test diagnostic.
    expect(result.text === text).toBe(true);
    expect(result.redacted).toBe(false);
    expectClipboardBoundary(2);
    expectPrivateEqual(fixture.events, [
      { operation: 'WRITE', result: 'SUCCESS', characterCount: text.length },
      { operation: 'READ', result: 'SUCCESS', characterCount: text.length },
    ]);
  });

  it.each([
    { label: 'ASCII', text: 'a'.repeat(1048577) },
    { label: 'Korean', text: '한'.repeat(349525) + 'ab' },
    { label: 'paired Unicode', text: '😀'.repeat(262144) + 'a' },
  ])('refuses $label one byte above 1 MiB before a write', async ({ text }) => {
    expect(Buffer.byteLength(text)).toBe(1048577);
    await safeFailure(fixture.clipboard().writeText(text), 'PAYLOAD_TOO_LARGE');
    expectNoExecution();
    expectPrivateEqual(fixture.events, [{ operation: 'WRITE', result: 'FAILURE', characterCount: null }]);
  });

  it('rejects one byte above the native read limit without exposing the partial stdout', async () => {
    fixture.configure('powershell.exe', 'stdout-overflow');
    await safeFailure(fixture.clipboard().readText(), 'CLIPBOARD_FAILED');
    expectPrivateEqual(fixture.events, [{ operation: 'READ', result: 'FAILURE', characterCount: null }]);
    expectClipboardBoundary(1);
  });

  it.each([
    { label: 'NUL', value: 'private\0text' },
    { label: 'high surrogate', value: '\ud800' },
    { label: 'low surrogate', value: '\udfff' },
    { label: 'reversed surrogate pair', value: '\udc00\ud800' },
    { label: 'number', value: 7 },
    { label: 'null', value: null },
    { label: 'byte array', value: Buffer.from('text') },
    { label: 'execution object', value: { text: 'data', script: 'whoami', shell: true } },
  ])('rejects $label input before native write', async ({ value }) => {
    await safeFailure(fixture.clipboard().writeText(value as string), 'INVALID_TEXT');
    expectNoExecution();
    expectPrivateEqual(fixture.events, [{ operation: 'WRITE', result: 'FAILURE', characterCount: null }]);
  });

  it.each([
    { label: 'truncated UTF-8', bytes: [0xe2, 0x82] },
    { label: 'overlong UTF-8', bytes: [0xc0, 0xaf] },
    { label: 'encoded surrogate', bytes: [0xed, 0xa0, 0x80] },
    { label: 'invalid UTF-8 lead', bytes: [0xff, 0xfe] },
    { label: 'UTF-16 instead of UTF-8', bytes: [0x41, 0x00, 0x42, 0x00] },
    { label: 'embedded NUL', bytes: [0x61, 0x00, 0x62] },
  ])('fails closed on $label from a real process', async ({ bytes }) => {
    fixture.configure('powershell.exe', 'bytes', Buffer.from(bytes));
    await safeFailure(fixture.clipboard().readText(), 'CLIPBOARD_FAILED');
    expectPrivateEqual(fixture.events, [{ operation: 'READ', result: 'FAILURE', characterCount: null }]);
  });
});

describe('Existing SecretRedactor reuse, audit and non-disclosure', () => {
  it.each([
    {
      label: 'registered literal with regex characters',
      text: 'safe registered.[a]$(x)&value safe',
      secrets: ['registered.[a]$(x)&value'],
      expected: 'safe ' + marker + ' safe',
    },
    { label: 'OpenAI token shape', text: 'sk-fixture0123456789TOKENvalue', secrets: [], expected: marker },
    { label: 'GitHub PAT shape', text: 'github_pat_fixture0123456789TOKEN', secrets: [], expected: marker },
    ...['o', 'p', 'u', 's', 'r'].map((kind) => ({
      label: 'GitHub ' + kind + ' token shape',
      text: 'gh' + kind + '_fixture0123456789TOKEN',
      secrets: [],
      expected: marker,
    })),
    {
      label: 'Bearer header',
      text: 'Authorization: Bearer opaque-fixture-private-value',
      secrets: [],
      expected: 'Authorization: Bearer ' + marker,
    },
  ])('masks $label before the public response and keeps sinks metadata-only', async ({ text, secrets, expected }) => {
    fixture.configure('powershell.exe', 'bytes', Buffer.from(text));
    const observed = await observeParentSinks(() => fixture.clipboard(secrets).readText());
    expectPrivateEqual(observed.value, { text: expected, redacted: true });
    expect(observed.output.length === 0, 'Parent output must remain empty.').toBe(true);
    expectPrivateEqual(fixture.events, [{ operation: 'READ', result: 'SUCCESS', characterCount: text.length }]);
    expect(JSON.stringify(fixture.events).includes(text)).toBe(false);
    for (const secret of secrets) expect(JSON.stringify(observed).includes(secret)).toBe(false);
  });

  it.each([
    { label: 'Slack token shape', text: 'xoxb-fixture-0123456789-token' },
    { label: 'AWS key shape', text: 'AKIA1234567890ABCDEF' },
    { label: 'JWT shape', text: 'eyJmaXh0dXJlIjp0cnVlfQ.eyJzdWIiOiJmaXh0dXJlIn0.signature_fixture' },
    {
      label: 'PEM private key shape',
      text: '-----BEGIN PRIVATE KEY-----\nsynthetic-fixture-body\n-----END PRIVATE KEY-----',
    },
  ])('refuses unverified $label and permits complete registered masking', async ({ text }) => {
    fixture.configure('powershell.exe', 'bytes', Buffer.from(text));
    const observed = await observeParentSinks(async () => {
      await safeFailure(fixture.clipboard().readText(), 'REDACTION_FAILED', [text]);
      return fixture.clipboard([text]).readText();
    });
    expectPrivateEqual(observed.value, { text: marker, redacted: true });
    expect(observed.output.length === 0, 'Parent output must remain empty.').toBe(true);
    expectPrivateEqual(fixture.events, [
      { operation: 'READ', result: 'FAILURE', characterCount: text.length },
      { operation: 'READ', result: 'SUCCESS', characterCount: text.length },
    ]);
  });

  it.each([
    { label: 'absent redactor', redactor: undefined },
    { label: 'identity redactor', redactor: { redact: (text: string) => text } },
    {
      label: 'throwing redactor',
      redactor: {
        redact: () => {
          throw new Error(privateCanary);
        },
      },
    },
    { label: 'object-returning redactor', redactor: { redact: () => ({ raw: privateCanary }) } },
    { label: 'async fulfilled redactor', redactor: { redact: async () => marker } },
    {
      label: 'async rejected redactor',
      redactor: {
        redact: async () => {
          throw new Error(privateCanary);
        },
      },
    },
  ])('rejects an $label configuration before touching the clipboard', async ({ redactor }) => {
    const service = fixture.clipboard([], { redactor: redactor as WindowsClipboardOptions['redactor'] });
    const observed = await observeParentSinks(async () => {
      await safeFailure(service.readText(), 'REDACTION_FAILED');
      await safeFailure(service.writeText(privateCanary), 'REDACTION_FAILED');
      await new Promise<void>((resolve) => setImmediate(resolve)); // rejected native Promises must be consumed
    });
    expect(observed.output.length === 0, 'Parent output must remain empty.').toBe(true);
    expectNoExecution();
    expectPrivateEqual(fixture.events, [
      { operation: 'READ', result: 'FAILURE', characterCount: null },
      { operation: 'WRITE', result: 'FAILURE', characterCount: privateCanary.length },
    ]);
  });

  it.each([
    { label: 'registered value leak', output: privateCanary },
    { label: 'new token shape', output: 'sk-fixture0123456789NEWtoken' },
    { label: 'NUL', output: 'unsafe\0text' },
    { label: 'unpaired Unicode', output: '\ud800' },
    { label: 'over-limit redacted output', output: 'x'.repeat(1048577) },
  ])('rejects $label after configuration probes have passed', async ({ output }) => {
    const input = 'ordinary fixture content that selects the adversarial output';
    const actual = new SecretRedactor([privateCanary]);
    const service = fixture.clipboard([privateCanary], {
      redactor: { redact: (text) => (text === input ? output : actual.redact(text)) },
    });
    fixture.configure('powershell.exe', 'bytes', Buffer.from(input));
    await safeFailure(service.readText(), 'REDACTION_FAILED', [input]);
    expect(fixture.calls()).toHaveLength(1);
    expectPrivateEqual(fixture.events, [{ operation: 'READ', result: 'FAILURE', characterCount: input.length }]);
  });

  it('rejects output that is not stable under a second redaction pass', async () => {
    const input = 'ordinary fixture content for idempotence';
    const actual = new SecretRedactor();
    const service = fixture.clipboard([], {
      redactor: {
        redact: (text) =>
          text === input
            ? 'first replacement'
            : text === 'first replacement'
              ? 'second replacement'
              : actual.redact(text),
      },
    });
    fixture.configure('powershell.exe', 'bytes', Buffer.from(input));
    await safeFailure(service.readText(), 'REDACTION_FAILED', [input]);
    expect(fixture.calls()).toHaveLength(1);
  });

  it('keeps raw write text and registered secrets out of parent stdout, stderr, audit and serialization', async () => {
    const text = privateCanary + '\nAuthorization: Bearer fixture-token-that-must-not-be-logged';
    const service = fixture.clipboard([privateCanary]);
    const observed = await observeParentSinks(() => service.writeText(text));
    expect(observed.value === undefined, 'Void operation returned a value.').toBe(true);
    expect(observed.output.length === 0, 'Parent output must remain empty.').toBe(true);
    expect(Buffer.compare(fixture.stdin(), Buffer.from(text))).toBe(0);
    expectPrivateEqual(fixture.events, [{ operation: 'WRITE', result: 'SUCCESS', characterCount: text.length }]);
    expect(JSON.stringify({ service, events: fixture.events }).includes(privateCanary)).toBe(false);
  });

  it.each(['READ', 'WRITE'] as const)('withholds %s success when the audit sink rejects', async (operation) => {
    const events: unknown[] = [];
    const service = fixture.clipboard([privateCanary], {
      audit: {
        record: async (event) => {
          events.push(event);
          throw new Error(privateCanary);
        },
      },
    });
    fixture.configure('powershell.exe', 'bytes', operation === 'READ' ? Buffer.from(privateCanary) : undefined);
    const observed = await observeParentSinks(() =>
      safeFailure(operation === 'READ' ? service.readText() : service.writeText(privateCanary), 'AUDIT_FAILED'),
    );
    expect(observed.output.length === 0, 'Parent output must remain empty.').toBe(true);
    expectPrivateEqual(events, [{ operation, result: 'SUCCESS', characterCount: privateCanary.length }]);
    expectClipboardBoundary(1); // a completed write is not rolled back or retried after audit failure
  });

  it('requires an audit sink before either clipboard operation', async () => {
    const service = new WindowsClipboardService({
      redactor: new SecretRedactor(),
      registeredSecrets: [],
      audit: undefined,
    } as unknown as WindowsClipboardOptions);
    await safeFailure(service.readText(), 'AUDIT_FAILED');
    await safeFailure(service.writeText(privateCanary), 'AUDIT_FAILED');
    expectNoExecution();
  });

  it('does not let an audit error reveal a rejected input', async () => {
    const service = fixture.clipboard([], {
      audit: {
        record: () => {
          throw new Error(privateCanary);
        },
      },
    });
    await safeFailure(service.writeText(privateCanary + '\0'), 'AUDIT_FAILED');
    expectNoExecution();
  });
});

describe('Scalar service methods do not expose execution options', () => {
  const injected = {
    executable: 'cmd.exe',
    command: 'whoami',
    args: ['/c', 'whoami'],
    script: '$([System.Environment]::UserName)',
    shell: true,
    cwd: '/private/overridden-directory',
    env: { PATH: '/private/overridden-bin', COMSPEC: 'cmd.exe' },
  };

  it('does not treat extra JavaScript arguments as Windows path, open or reveal options', async () => {
    // These are scalar library APIs. This is not a substitute for future MCP strict schemas.
    const paths = new WindowsPathService();
    const open = new WindowsOpenService();
    const reveal = new WindowsRevealService();
    await Reflect.apply(paths.toWindows, paths, ['/mnt/synthetic/data', injected]);
    await Reflect.apply(paths.toLinux, paths, [fixture.windowsPath, injected]);
    await Reflect.apply(open.openPath, open, [fixture.windowsPath, injected]);
    await Reflect.apply(open.openUrl, open, ['https://example.test/', injected]);
    await Reflect.apply(reveal.revealPath, reveal, [fixture.windowsPath, injected]);
    expectExecBoundary([
      { role: 'wslpath', args: ['-w', '/mnt/synthetic/data'] },
      { role: 'wslpath', args: ['-u', fixture.windowsPath] },
      { role: 'wslpath', args: ['-u', fixture.windowsPath] },
      { role: 'wslpath', args: ['-w', fixture.directory] },
      { role: 'explorer.exe', args: [fixture.windowsPath + '\\'] },
      { role: 'explorer.exe', args: ['https://example.test/'] },
      { role: 'explorer.exe', args: ['/select,', fixture.windowsPath] },
    ]);
  });

  it('does not treat extra clipboard arguments as executable, script or environment selection', async () => {
    const clipboard = fixture.clipboard();
    const text = 'ordinary data & $(whoami)';
    expectPrivateEqual(await clipboard.readText(), { text: '', redacted: false });
    await clipboard.writeText(text);
    const variants = [
      injected,
      {
        ...injected,
        executable: 'pwsh.exe',
        command: 'Get-Process',
        args: ['-Command', 'Get-Process'],
        script: 'Write-Output second-injected-script',
        env: { TEMP: '/private/second-temp', WSLENV: 'GRAM_WINDOWS_ESCAPE_CANARY' },
      },
    ];
    for (const options of variants) {
      expectPrivateEqual(await Reflect.apply(clipboard.readText, clipboard, [options]), { text: '', redacted: false });
      await Reflect.apply(clipboard.writeText, clipboard, [text, options]);
      expect(Buffer.compare(fixture.stdin(), Buffer.from(text))).toBe(0);
    }
    const argv = expectClipboardBoundary(6);
    expect(argv[0]).not.toEqual(argv[1]);
    for (const index of [2, 4]) {
      // Compare independently against the actual clean READ and WRITE processes.
      // A base64-shaped attacker script is insufficient: the full argv must match.
      expect(argv[index]).toEqual(argv[0]);
      expect(argv[index + 1]).toEqual(argv[1]);
      const calls = vi.mocked(spawn).mock.calls;
      expect(calls[index]?.[2]).toEqual(calls[0]?.[2]);
      expect(calls[index + 1]?.[2]).toEqual(calls[1]?.[2]);
    }
  });

  it('rejects option objects in place of each required scalar target', async () => {
    const value = { ...injected, windowsPath: fixture.windowsPath };
    await safeFailure(new WindowsOpenService().openPath(value as unknown as string), 'INVALID_PATH');
    await safeFailure(new WindowsRevealService().revealPath(value as unknown as string), 'INVALID_PATH');
    await safeFailure(new WindowsOpenService().openUrl(value as unknown as string), 'INVALID_URL');
    await safeFailure(new WindowsPathService().toLinux(value as unknown as string), 'INVALID_PATH');
    await safeFailure(fixture.clipboard().writeText(value as unknown as string), 'INVALID_TEXT');
    expectNoExecution();
  });
});

describe('Real Linux child-process failures remain bounded and private', () => {
  const cases: {
    label: string;
    role: NativeRole;
    code: string;
    calls: number;
    run: () => Promise<unknown>;
  }[] = [
    {
      label: 'toWindows',
      role: 'wslpath',
      code: 'CONVERSION_FAILED',
      calls: 1,
      run: () => new WindowsPathService().toWindows('/mnt/' + privateCanary),
    },
    {
      label: 'toLinux',
      role: 'wslpath',
      code: 'CONVERSION_FAILED',
      calls: 1,
      run: () => new WindowsPathService().toLinux('R:\\' + privateCanary),
    },
    {
      label: 'openPath',
      role: 'explorer.exe',
      code: 'OPERATION_FAILED',
      calls: 3,
      run: () => new WindowsOpenService().openPath('R:\\' + privateCanary),
    },
    {
      label: 'openUrl',
      role: 'explorer.exe',
      code: 'OPERATION_FAILED',
      calls: 1,
      run: () => new WindowsOpenService().openUrl('https://example.test/' + privateCanary),
    },
    {
      label: 'revealPath',
      role: 'explorer.exe',
      code: 'OPERATION_FAILED',
      calls: 1,
      run: () => new WindowsRevealService().revealPath('R:\\' + privateCanary),
    },
    {
      label: 'readText',
      role: 'powershell.exe',
      code: 'CLIPBOARD_FAILED',
      calls: 1,
      run: () => fixture.clipboard([privateCanary]).readText(),
    },
    {
      label: 'writeText',
      role: 'powershell.exe',
      code: 'CLIPBOARD_FAILED',
      calls: 1,
      run: () => fixture.clipboard([privateCanary]).writeText(privateCanary),
    },
  ];
  const modes: NativeMode[] = ['nonzero', 'signal', 'stdout-overflow', 'stderr-overflow'];
  it.each(cases.flatMap((test) => modes.map((mode) => ({ ...test, mode }))))(
    'sanitizes $mode through the actual $label boundary without retrying',
    async ({ role, mode, code, calls, run }) => {
      fixture.configure(role, mode);
      const observed = await observeParentSinks(() => safeFailure(run(), code));
      expect(observed.output.length === 0, 'Parent output must remain empty.').toBe(true);
      expect(fixture.calls()).toHaveLength(calls);
      expect(JSON.stringify(fixture.events).includes(privateCanary)).toBe(false);
    },
  );

  it.each(['READ', 'WRITE'] as const)('rejects any %s stderr even on native exit zero', async (operation) => {
    fixture.configure('powershell.exe', 'stderr');
    const clipboard = fixture.clipboard([privateCanary]);
    const observed = await observeParentSinks(() =>
      safeFailure(operation === 'READ' ? clipboard.readText() : clipboard.writeText(privateCanary), 'CLIPBOARD_FAILED'),
    );
    expect(observed.output.length === 0, 'Parent output must remain empty.').toBe(true);
    expect(fixture.calls()).toHaveLength(1);
  });

  it('rejects even one stdout byte from a write without leaking it', async () => {
    fixture.configure('powershell.exe', 'bytes', Buffer.from(privateCanary));
    const observed = await observeParentSinks(() =>
      safeFailure(fixture.clipboard().writeText('ordinary input'), 'CLIPBOARD_FAILED'),
    );
    expect(observed.output.length === 0, 'Parent output must remain empty.').toBe(true);
    expect(fixture.calls()).toHaveLength(1);
  });

  it.each(cases.filter((test) => ['toWindows', 'openUrl', 'readText', 'writeText'].includes(test.label)))(
    'kills a stuck direct child for $label at the configured timeout',
    async ({ role, code, run }) => {
      fixture.configure(role, 'hang');
      const started = performance.now();
      await safeFailure(run(), code);
      const elapsed = performance.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(4000);
      expect(elapsed).toBeLessThan(7000);
      await vi.waitFor(() => expect(actualChildren().map((child) => child.signalCode)).toEqual(['SIGKILL']));
      expect(fixture.calls()).toHaveLength(1);
      // Path/Explorer promise no shared wall-clock deadline for all openPath phases.
    },
  );

  it.each(cases.filter((test) => ['toWindows', 'openUrl', 'readText', 'writeText'].includes(test.label)))(
    'sanitizes a missing fixed executable for $label',
    async ({ role, code, run }) => {
      rmSync(join(fixture.root, role));
      const observed = await observeParentSinks(() => safeFailure(run(), code));
      expect(observed.output.length === 0, 'Parent output must remain empty.').toBe(true);
      expect(fixture.calls()).toEqual([]);
    },
  );

  it('discards private native output after a successful Explorer call', async () => {
    fixture.configure('explorer.exe', 'stderr', Buffer.from(privateCanary));
    const observed = await observeParentSinks(() =>
      new WindowsOpenService().openUrl('https://example.test/' + privateCanary),
    );
    expect(observed.value === undefined, 'Void operation returned a value.').toBe(true);
    expect(observed.output.length === 0, 'Parent output must remain empty.').toBe(true);
    expect(fixture.calls()).toHaveLength(1);
  });

  it('does not log a successful path response', async () => {
    const path = 'R:\\' + privateCanary;
    fixture.configure('wslpath', 'success', undefined, { windowsPath: path });
    const observed = await observeParentSinks(() => new WindowsPathService().toWindows('/mnt/' + privateCanary));
    expect(observed.value === path).toBe(true); // the requested data result is distinct from diagnostic disclosure
    expect(observed.output.length === 0, 'Parent output must remain empty.').toBe(true);
  });
});

describe('Actual Policy Engine raw Windows approval boundary', () => {
  const context = { taskId: 'windows-escape-regression' };
  const rawExecutables = [
    { executable: 'powershell.exe', ruleId: 'POL-WIN-RAW-EXEC' },
    { executable: 'pwsh.exe', ruleId: 'POL-WIN-RAW-EXEC' },
    { executable: 'cmd.exe', ruleId: 'POL-WIN-RAW-EXEC' },
    { executable: 'arbitrary.exe', ruleId: 'POL-WIN-RAW-EXEC' },
    { executable: 'R:\\custom\\powershell.exe', ruleId: 'POL-WIN-RAW-EXEC' },
    { executable: '/mnt/custom/bin/cmd.exe', ruleId: 'POL-WIN-RAW-EXEC' },
    { executable: 'PowerShell.EXE', ruleId: 'POL-UNKNOWN-COMMAND' },
    { executable: 'CMD.EXE', ruleId: 'POL-UNKNOWN-COMMAND' },
    { executable: 'powershell', ruleId: 'POL-UNKNOWN-COMMAND' },
    { executable: 'pwsh', ruleId: 'POL-UNKNOWN-COMMAND' },
    { executable: 'cmd', ruleId: 'POL-UNKNOWN-COMMAND' },
  ];

  it.each(rawExecutables)('requires approval for direct $executable', ({ executable, ruleId }) => {
    const operation = normalizeExecutableCommand(executable, ['synthetic-argument'], fixture.root);
    const decision = new PolicyEngine().evaluate(operation, context);
    expect(decision).toMatchObject({ kind: 'NEEDS_APPROVAL', ruleId });
    expect(decision.operationHash).toMatch(/^[a-f0-9]{64}$/u);
    expectNoExecution();
  });

  it.each([
    "powershell.exe -NoProfile -Command '$(Get-Date)'",
    "pwsh.exe -NoProfile -Command 'Write-Output synthetic'",
    "cmd.exe /d /c 'echo synthetic'",
    'env FIXTURE=value cmd.exe /d /c ver',
    'sudo -- powershell.exe -NoProfile -Command Get-Date',
    'sudo env FIXTURE=value pwsh.exe -NoProfile -Command Get-Date',
  ])('retains raw approval after shell normalization of %s', (command) => {
    const operations = normalizeShellCommand(command, fixture.root);
    expect(operations).toHaveLength(1);
    for (const operation of operations) {
      expect(new PolicyEngine().evaluate(operation, context)).toMatchObject({
        kind: 'NEEDS_APPROVAL',
        ruleId: 'POL-WIN-RAW-EXEC',
      });
    }
    expectNoExecution();
  });

  it.each([';', '&&', '||', '|'])('keeps each composed Windows operation approval-gated after %s', (separator) => {
    const operations = normalizeShellCommand('node --version ' + separator + ' cmd.exe /d /c ver', fixture.root);
    expect(operations.map((operation) => operation.executable)).toEqual(['node', 'cmd.exe']);
    expect(operations.map((operation) => new PolicyEngine().evaluate(operation, context).kind)).toEqual([
      'ALLOW',
      'NEEDS_APPROVAL',
    ]);
    expectNoExecution();
  });

  it.each([
    { label: 'unquoted substitution', command: 'powershell.exe -Command $(whoami)' },
    { label: 'double-quoted substitution', command: 'powershell.exe -Command "$(whoami)"' },
    { label: 'backtick substitution', command: 'cmd.exe /c `whoami`' },
    { label: 'newline', command: 'node --version\ncmd.exe /c ver' },
    { label: 'single ampersand', command: 'node --version & cmd.exe /c ver' },
    { label: 'redirection', command: 'cmd.exe /c ver > private-file' },
  ])('rejects unsupported $label before policy evaluation', ({ command }) => {
    expect(() => normalizeShellCommand(command, fixture.root)).toThrow(UnsupportedShellSyntaxError);
    expectNoExecution();
  });

  it('binds approval identity to the actual raw arguments', () => {
    const first = normalizeExecutableCommand('powershell.exe', ['-Command', 'Get-Date'], fixture.root);
    const second = normalizeExecutableCommand('powershell.exe', ['-Command', 'Get-Process'], fixture.root);
    const policy = new PolicyEngine();
    expect(policy.evaluate(first, context).kind).toBe('NEEDS_APPROVAL');
    expect(policy.evaluate(second, context).kind).toBe('NEEDS_APPROVAL');
    expect(policy.evaluate(first, context).operationHash).not.toBe(policy.evaluate(second, context).operationHash);
    expect(policy.evaluate(normalizeExecutableCommand('node', ['--version'], fixture.root), context).kind).toBe(
      'ALLOW',
    ); // positive control: these tests do not replace the engine with deny-all
  });

  it('proves real Linux env consumes the unset operand and invokes the fixed CMD fixture', async () => {
    await new Promise<void>((resolve, reject) => {
      execFile(
        '/usr/bin/env',
        ['-u', 'node', 'cmd.exe', '/d', '/c', 'ver'],
        {
          shell: false,
          timeout: 2000,
          killSignal: 'SIGKILL',
          maxBuffer: 4096,
          env: { PATH: fixture.root, node: 'synthetic-unset-variable' },
        },
        (error) => {
          if (error) reject(error);
          else resolve();
        },
      );
    });
    expect(fixture.calls().map(({ role, args, environment }) => ({ role, args, environment }))).toEqual([
      { role: 'cmd.exe', args: ['/d', '/c', 'ver'], environment: {} },
    ]);
    // This fixture only records argv. No CMD/PowerShell code, sudo, Windows or MCP is executed.
  });

  // Blocking acceptance regressions: inherited #209 policy code currently misidentifies
  // an option operand as "node" and returns ALLOW. Keep these ordinary assertions RED
  // until the policy owner fixes/rejects the syntax; never use fails/skip or accept ALLOW.
  it.each([
    { label: 'env unset wrapping CMD', command: 'env -u node cmd.exe /d /c ver', executable: 'cmd.exe' },
    {
      label: 'env unset wrapping PowerShell',
      command: 'env -u node powershell.exe -NoProfile -Command Get-Date',
      executable: 'powershell.exe',
    },
    {
      label: 'env unset wrapping pwsh',
      command: 'env -u node pwsh.exe -NoProfile -Command Get-Date',
      executable: 'pwsh.exe',
    },
    { label: 'sudo user wrapping CMD', command: 'sudo -u node cmd.exe /d /c ver', executable: 'cmd.exe' },
  ])('requires raw approval for $label', ({ command, executable }) => {
    const operations = normalizeShellCommand(command, fixture.root);
    expect(operations).toHaveLength(1);
    const operation = operations[0];
    expect(operation).toBeDefined();
    if (!operation) throw new Error('Expected one normalized operation.');
    const decision = new PolicyEngine().evaluate(operation, context);
    expect({ executable: operation.executable, kind: decision.kind }).toEqual({ executable, kind: 'NEEDS_APPROVAL' });
    expectNoExecution();
  });
});
