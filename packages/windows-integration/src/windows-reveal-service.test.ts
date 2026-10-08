import { describe, expect, it } from 'vitest';
import { type FixedWindowsOperation } from './fixed-windows-runner.js';
import { WindowsRevealService } from './windows-reveal-service.js';

describe('WindowsRevealService', () => {
  it.each([
    'Q:\\Other User\\한글 🧵 file.txt',
    '\\\\wsl.localhost\\Custom-Distro\\home\\another\\file.txt',
    '\\\\server\\share name\\file.txt',
    "z:\\'literal'; & $(data) ^ file.txt",
    'Q:\\payload.exe',
    'Q:\\payload.cmd',
    'Q:\\payload.ps1',
    'Q:\\shortcut.lnk',
  ])('selects %s without substituting an open operation', async (windowsPath) => {
    const calls: FixedWindowsOperation[] = [];
    const service = new WindowsRevealService({
      async run(operation) {
        calls.push(operation);
      },
    });
    await expect(service.revealPath(windowsPath)).resolves.toBeUndefined();
    expect(calls).toEqual([{ kind: 'REVEAL_PATH', windowsPath }]);
  });

  it.each([
    null,
    '',
    { path: 'Q:\\target', script: 'arbitrary source' },
    'Q:\\target\0',
    'Q:\\target\n',
    'Q:relative',
    'relative',
    '/select,Q:\\file',
    '/root,Q:\\file',
    '-Embedding',
    '\\\\?\\Q:\\file',
    'Q:\\a,/root,Q:\\payload.exe',
    'Q:\\a" /root, Q:\\payload.exe',
    'file:///Q:/file',
    'javascript:alert(1)',
    'shell:AppsFolder',
    'ms-settings:display',
    'https://example.test/',
  ])('rejects unsafe path %j before dispatch', async (path) => {
    const calls: FixedWindowsOperation[] = [];
    const service = new WindowsRevealService({
      async run(operation) {
        calls.push(operation);
      },
    });
    await expect(service.revealPath(path as string)).rejects.toMatchObject({
      name: 'WindowsIntegrationError',
      code: 'INVALID_PATH',
    });
    expect(calls).toEqual([]);
  });

  it('sanitizes asynchronous runner failures', async () => {
    const privatePath = 'Q:\\private path';
    const service = new WindowsRevealService({
      async run() {
        throw Object.assign(new Error('native failure ' + privatePath), { stderr: 'private stderr' });
      },
    });
    const error: unknown = await service.revealPath(privatePath).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ name: 'WindowsIntegrationError', code: 'OPERATION_FAILED' });
    expect(String(error)).not.toContain(privatePath);
    expect(error).not.toHaveProperty('cause');
    expect(error).not.toHaveProperty('stderr');
  });
});
