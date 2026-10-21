import { describe, expect, it } from 'vitest';
import { detectPlatform } from './detect.js';

const mac = { platform: 'darwin', arch: 'arm64', release: '24.0.0', nodeVersion: '24.1.0' };

describe('platform detection', () => {
  it('selects native arm64 macOS without claiming operational readiness', () => {
    expect(detectPlatform(mac)).toEqual({
      kind: 'macos-arm64', compatible: true, reason: 'SUPPORTED_TARGET',
    });
  });
  it('requires an arm64 Node binary on macOS, including translated x64 Node', () => {
    expect(detectPlatform({ ...mac, arch: 'x64' })).toEqual({
      kind: 'unsupported', compatible: false, reason: 'MACOS_ARM64_REQUIRED',
    });
  });
  it('selects only an explicit WSL2-like kernel hint, not ordinary Linux or WSL1', () => {
    const linux = { ...mac, platform: 'linux', arch: 'x64' };
    expect(detectPlatform({ ...linux, release: '6.6.87.2-microsoft-standard-WSL2' }).kind)
      .toBe('linux-wsl');
    for (const release of ['6.8.0-generic', '4.4.0-19041-Microsoft', '']) {
      expect(detectPlatform({ ...linux, release }).compatible).toBe(false);
    }
  });
  it.each(['23.11.0', '25.0.0', 'garbage', '24', '', '24.1.0-rc.1'])(
    'rejects unsupported or malformed Node version %s', (nodeVersion) => {
      expect(detectPlatform({ ...mac, nodeVersion }).reason).toBe('NODE_24_REQUIRED');
    },
  );
  it('rejects Windows-native and unknown platforms without selecting a default adapter', () => {
    for (const platform of ['win32', 'freebsd', '']) {
      expect(detectPlatform({ ...mac, platform }).reason).toBe('UNSUPPORTED_PLATFORM');
    }
  });
});
