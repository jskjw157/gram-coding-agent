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
    expect(calls).toEqual([
      { executable: 'wslpath', args: ['-w', '/home/example/한글 file.txt'] },
    ]);
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
    expect(calls).toEqual([
      { executable: 'wslpath', args: ['-u', 'q:\\Other User\\보고서 final.txt'] },
    ]);
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
    const service = new WindowsPathService({ async run() { return output; } });
    expect(await service.toWindows('/input')).toBe(expected);
  });
});
