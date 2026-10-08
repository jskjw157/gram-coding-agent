import { describe, expect, it } from 'vitest';
import { WindowsPathService, type WindowsPathInvocation } from './windows-path-service.js';

describe('WindowsPathService conversions', () => {
  it('passes a Linux path as one literal argument to the fixed converter', async () => {
    const calls: WindowsPathInvocation[] = [];
    const service = new WindowsPathService({
      async run(request) {
        calls.push(request);
        return 'E:\\converted\\한글 file.txt\n';
      },
    });

    expect(await service.toWindows('/home/example/한글 file.txt')).toBe('E:\\converted\\한글 file.txt');
    expect(calls).toEqual([{ executable: 'wslpath', args: ['-w', '/home/example/한글 file.txt'] }]);
  });

  it('uses the reverse direction without deriving drive or mount mappings', async () => {
    const calls: WindowsPathInvocation[] = [];
    const service = new WindowsPathService({
      async run(request) {
        calls.push(request);
        return '/custom-mount/보고서 final.txt\n';
      },
    });

    expect(await service.toLinux('q:\\Other User\\보고서 final.txt')).toBe('/custom-mount/보고서 final.txt');
    expect(calls).toEqual([{ executable: 'wslpath', args: ['-u', 'q:\\Other User\\보고서 final.txt'] }]);
  });

  it.each([
    ['\\\\wsl.localhost\\CustomDistro\\home\\another\\file.txt', '/home/another/file.txt'],
    ['\\\\wsl$\\Different-Distro\\home\\someone\\file.txt', '/home/someone/file.txt'],
    ['\\\\fileserver\\share name\\file.txt', '/remote/share/file.txt'],
  ])('delegates UNC input unchanged: %s', async (path, converted) => {
    const calls: WindowsPathInvocation[] = [];
    const service = new WindowsPathService({
      async run(request) {
        calls.push(request);
        return `${converted}\n`;
      },
    });

    expect(await service.toLinux(path)).toBe(converted);
    expect(calls).toEqual([{ executable: 'wslpath', args: ['-u', path] }]);
  });

  it.each([
    ['E:\\leading and trailing  \n', 'E:\\leading and trailing  '],
    ['E:\\leading and trailing  \r\n', 'E:\\leading and trailing  '],
    ['  relative path  \n', '  relative path  '],
    ['E:\\already unframed', 'E:\\already unframed'],
  ])('removes only a single terminal line ending from %j', async (output, expected) => {
    const service = new WindowsPathService({
      async run() {
        return output;
      },
    });
    expect(await service.toWindows('/input')).toBe(expected);
  });
});

const methods = ['toWindows', 'toLinux'] as const;

describe.each(methods)('%s input boundary', (method) => {
  it.each([
    { label: 'empty string', path: '' },
    { label: 'whitespace only', path: ' \t ' },
    { label: 'null', path: null },
    { label: 'undefined', path: undefined },
    { label: 'number', path: 17 },
    { label: 'boolean', path: false },
    { label: 'array', path: ['/path'] },
    { label: 'object', path: { path: '/path' } },
    { label: 'embedded NUL', path: '/path\0tail' },
    { label: 'line feed', path: '/path\ntail' },
    { label: 'carriage return', path: '/path\rtail' },
    { label: 'switch', path: '-w' },
    { label: 'long option', path: '--help' },
    { label: 'option terminator', path: '--' },
    { label: '8193 characters', path: 'a'.repeat(8193) },
    { label: 'unpaired high surrogate', path: '/path/\ud800' },
    { label: 'unpaired low surrogate', path: '/path/\udc00' },
  ])('rejects $label before invoking the runner', async ({ path }) => {
    const calls: WindowsPathInvocation[] = [];
    const service = new WindowsPathService({
      async run(request) {
        calls.push(request);
        return '/converted\n';
      },
    });

    await expect(service[method](path as string)).rejects.toMatchObject({
      name: 'WindowsPathError',
      code: 'INVALID_PATH',
    });
    expect(calls).toEqual([]);
  });

  it('accepts exactly 8192 Unicode characters without treating them as a byte limit', async () => {
    const path = '한'.repeat(8192);
    const calls: WindowsPathInvocation[] = [];
    const service = new WindowsPathService({
      async run(request) {
        calls.push(request);
        return '/converted\n';
      },
    });

    expect(await service[method](path)).toBe('/converted');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[1]).toBe(path);
  });

  it.each([
    '/home/다른 사용자/한글 🧵 \'single\' "double" ; & | $(echo data) `tick` %COMSPEC%.txt',
    'R:\\Other User\\한글 🧵 \'single\' "double" ; & | $(echo data) `tick` %COMSPEC%.txt',
    './-w',
    '.\\--help',
    '  relative path  ',
  ])('preserves literal path data in a single argument: %s', async (path) => {
    const calls: WindowsPathInvocation[] = [];
    const service = new WindowsPathService({
      async run(request) {
        calls.push(request);
        return '/converted\n';
      },
    });

    expect(await service[method](path)).toBe('/converted');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.executable).toBe('wslpath');
    expect(calls[0]?.args).toHaveLength(2);
    expect(calls[0]?.args[1]).toBe(path);
  });
});

describe('WindowsPathService result boundary', () => {
  it.each([
    { label: 'empty output', output: '' },
    { label: 'only LF', output: '\n' },
    { label: 'only CRLF', output: '\r\n' },
    { label: 'blank path', output: ' \t \n' },
    { label: 'embedded NUL', output: '/path\0tail\n' },
    { label: 'extra line', output: '/path\nextra\n' },
    { label: 'two terminal line endings', output: '/path\n\n' },
    { label: 'unframed CR', output: '/path\r' },
    { label: '8193 characters', output: 'a'.repeat(8193) + '\n' },
    { label: 'unpaired surrogate', output: '/path/\ud800\n' },
    { label: 'undefined', output: undefined },
    { label: 'object', output: { stdout: '/path\n' } },
  ])('rejects $label as a malformed converter result', async ({ output }) => {
    const service = new WindowsPathService({
      async run() {
        return output as string;
      },
    });

    await expect(service.toLinux('R:\\input')).rejects.toMatchObject({
      name: 'WindowsPathError',
      code: 'INVALID_OUTPUT',
    });
  });

  it('applies the result limit after removing the terminal line ending', async () => {
    const output = '/' + '한'.repeat(8191);
    const service = new WindowsPathService({
      async run() {
        return output + '\n';
      },
    });
    expect(await service.toLinux('R:\\input')).toBe(output);
  });

  it('does not expose the runner exception, input, stderr, or cause', async () => {
    const privatePath = '/private/should-not-appear.txt';
    const rawError = Object.assign(new Error(`wslpath -w ${privatePath}: private stderr`), {
      stderr: 'private stderr',
      stdout: privatePath,
    });
    const service = new WindowsPathService({
      async run() {
        throw rawError;
      },
    });
    const error = await service.toWindows(privatePath).catch((cause: unknown) => cause);

    expect(error).toMatchObject({ name: 'WindowsPathError', code: 'CONVERSION_FAILED' });
    expect(error).not.toBe(rawError);
    expect(String(error)).not.toContain(privatePath);
    expect(String(error)).not.toContain('private stderr');
    expect(error).not.toHaveProperty('cause');
    expect(error).not.toHaveProperty('stderr');
    expect(error).not.toHaveProperty('stdout');
  });

  it('keeps concurrent requests separate when they complete in reverse order', async () => {
    const pending = new Map<string, (output: string) => void>();
    const service = new WindowsPathService({
      run({ args }) {
        return new Promise((resolve) => {
          pending.set(args[1], resolve);
        });
      },
    });
    const windows = service.toWindows('/first');
    const linux = service.toLinux('R:\\second');

    pending.get('R:\\second')?.('/converted-second\n');
    pending.get('/first')?.('Z:\\converted-first\n');

    expect(await windows).toBe('Z:\\converted-first');
    expect(await linux).toBe('/converted-second');
  });
});
