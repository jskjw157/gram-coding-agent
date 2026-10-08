import { describe, expect, it } from 'vitest';
import { type FixedWindowsOperation } from './fixed-windows-runner.js';
import { WindowsOpenService } from './windows-open-service.js';

function fixture() {
  const calls: FixedWindowsOperation[] = [];
  const service = new WindowsOpenService({
    async run(operation) {
      calls.push(operation);
    },
  });
  return { calls, service };
}

describe('WindowsOpenService paths', () => {
  it.each([
    'Q:\\',
    'r:\\Other User\\한글 🧵 folder',
    '\\\\wsl.localhost\\Different-Distro\\home\\another\\project',
    '\\\\wsl$\\Custom\\home\\someone\\project',
    '\\\\server\\share name\\folder',
    "Z:\\'literal'; & $(data) ^ folder",
  ])('submits one fixed directory-open operation for %s', async (windowsPath) => {
    const { calls, service } = fixture();
    await expect(service.openPath(windowsPath)).resolves.toBeUndefined();
    expect(calls).toEqual([{ kind: 'OPEN_PATH', windowsPath }]);
  });

  it.each([
    '',
    '   ',
    null,
    undefined,
    17,
    ['Q:\\folder'],
    { path: 'Q:\\folder', command: 'calc.exe' },
    'Q:\\nul\0tail',
    'Q:\\new\nline',
    'Q:\\carriage\rreturn',
    'Q:\\tab\tname',
    'Q:\\\ud800',
    'Q:\\\udc00',
    'Q:\\' + 'x'.repeat(8190),
    'relative\\folder',
    'Q:relative',
    '\\root-relative',
    '/select,Q:\\folder',
    '-Embedding',
    '--help',
    '/home/user/project',
    'file:///Q:/folder',
    'shell:AppsFolder',
    'ms-settings:display',
    'javascript:alert(1)',
    'https://example.test/folder',
    'Q:\\folder,/root,Q:\\payload.exe',
    'Q:\\folder" /select, Q:\\payload',
    'Q:\\%COMSPEC%',
    '\\\\?\\Q:\\folder',
    '\\\\.\\GLOBALROOT\\Device',
  ])('rejects unsafe or ambiguous target %j before dispatch', async (path) => {
    const { calls, service } = fixture();
    await expect(service.openPath(path as string)).rejects.toMatchObject({
      name: 'WindowsIntegrationError',
      code: 'INVALID_PATH',
    });
    expect(calls).toEqual([]);
  });

  it('does not narrow the conversion service contract to the Explorer contract', async () => {
    const { WindowsPathService } = await import('./windows-path-service.js');
    const source = '/home/한글 "quoted", %literal%';
    const converted = 'Q:\\한글 "quoted", %literal%';
    const conversions: string[] = [];
    const paths = new WindowsPathService({
      async run({ args }) {
        conversions.push(args[1]);
        return converted + '\n';
      },
    });
    expect(await paths.toWindows(source)).toBe(converted);
    expect(conversions).toEqual([source]);
    const { calls, service } = fixture();
    await expect(service.openPath(converted)).rejects.toMatchObject({ code: 'INVALID_PATH' });
    expect(calls).toEqual([]);
  });
});

describe('WindowsOpenService URLs', () => {
  it.each([
    ['https://example.test/path?q=one&other=two#section', 'https://example.test/path?q=one&other=two#section'],
    ['HTTP://Example.TEST:80/path', 'http://example.test/path'],
    ['https://example.test', 'https://example.test/'],
    ['http://localhost:3000/', 'http://localhost:3000/'],
    ['http://[::1]:8080/path', 'http://[::1]:8080/path'],
    ['https://example.test/한글', 'https://example.test/%ED%95%9C%EA%B8%80'],
    ['https://example.test/%2C%22?q=%20&data=$(literal);x', 'https://example.test/%2C%22?q=%20&data=$(literal);x'],
  ])('submits a normalized HTTP(S) URL as data: %s', async (url, expected) => {
    const { calls, service } = fixture();
    await expect(service.openUrl(url)).resolves.toBeUndefined();
    expect(calls).toEqual([{ kind: 'OPEN_URL', url: expected }]);
  });

  it.each([
    '',
    ' ',
    null,
    undefined,
    17,
    { url: 'https://example.test/', executable: 'cmd.exe' },
    'file:///Q:/payload.exe',
    'FILE://server/share/payload',
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'shell:AppsFolder',
    'ms-settings:display',
    'data:text/html,payload',
    'ftp://example.test/',
    'custom://example.test/',
    '//example.test/',
    'https:example.test/',
    'https:///example.test/',
    'https://',
    'https://user:password@example.test/',
    'https://user@example.test/',
    ' https://example.test/',
    'https://example.test/ ',
    'https://example.test/a b',
    'https://example.test/\0x',
    'https://exam\nple.test/',
    'https://exam\tple.test/',
    'https://example.test/\r',
    'https://example.test/\\payload',
    'https://example.test/"quoted"',
    'https://example.test/,/root,Q:\\payload.exe',
    'https://%2C/',
    'https://\uff0c/',
    'https://%22/',
    'https://example.test/\ud800',
    'https://example.test/' + 'x'.repeat(8192),
    'https://example.test/' + '한'.repeat(1000),
  ])('rejects invalid/prohibited/ambiguous URL %j before dispatch', async (url) => {
    const { calls, service } = fixture();
    await expect(service.openUrl(url as string)).rejects.toMatchObject({
      name: 'WindowsIntegrationError',
      code: 'INVALID_URL',
    });
    expect(calls).toEqual([]);
  });

  it('accepts the URL length boundary after serialization', async () => {
    const url = 'https://example.test/' + 'a'.repeat(8192 - 'https://example.test/'.length);
    const { calls, service } = fixture();
    await service.openUrl(url);
    expect(calls).toEqual([{ kind: 'OPEN_URL', url }]);
  });
});

describe('WindowsOpenService failures', () => {
  it.each(['openPath', 'openUrl'] as const)('sanitizes injected %s runner errors', async (method) => {
    const privateTarget = method === 'openPath' ? 'Q:\\private target' : 'https://example.test/?private=value';
    const raw = Object.assign(new Error('native failure ' + privateTarget), {
      stderr: 'private stderr',
      stdout: privateTarget,
    });
    const service = new WindowsOpenService({
      run() {
        throw raw;
      },
    });
    const error: unknown = await service[method](privateTarget).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ name: 'WindowsIntegrationError', code: 'OPERATION_FAILED' });
    expect(error).not.toBe(raw);
    expect(String(error)).not.toContain(privateTarget);
    expect(error).not.toHaveProperty('cause');
    expect(error).not.toHaveProperty('stdout');
    expect(error).not.toHaveProperty('stderr');
  });
});
