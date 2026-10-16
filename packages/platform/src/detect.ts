import type { HostFacts, PlatformDetection } from './contracts.js';

export function detectPlatform(facts: HostFacts): PlatformDetection {
  if (!/^24\.\d+\.\d+$/.test(facts.nodeVersion)) {
    return { kind: 'unsupported', compatible: false, reason: 'NODE_24_REQUIRED' };
  }
  if (facts.platform === 'darwin') {
    return facts.arch === 'arm64'
      ? { kind: 'macos-arm64', compatible: true, reason: 'SUPPORTED_TARGET' }
      : { kind: 'unsupported', compatible: false, reason: 'MACOS_ARM64_REQUIRED' };
  }
  if (facts.platform === 'linux' && /microsoft-standard.*wsl2/i.test(facts.release)) {
    return { kind: 'linux-wsl', compatible: true, reason: 'SUPPORTED_TARGET' };
  }
  return { kind: 'unsupported', compatible: false, reason: 'UNSUPPORTED_PLATFORM' };
}
