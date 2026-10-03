import { describe, expect, it } from 'vitest';
import type { LiveProcessHandle, NativePeerProofPort, MacProcessSeal } from './adapters/owned-process.js';

describe('role-aware native process seal', () => {
  it('seals a tunnel child without weakening the existing core-only connection verifier', async () => {
    const module = await import('./adapters/owned-process.js') as unknown as {
      sealMacOwnedProcess?: (
        handle: LiveProcessHandle,
        input: { role: 'core' | 'tunnel'; uid: number; generation: string; releaseDigest: string;
          executable: { dev: bigint; ino: bigint } },
        proof: NativePeerProofPort,
        signal: AbortSignal,
      ) => Promise<MacProcessSeal | null>;
    };
    expect(module.sealMacOwnedProcess).toBeTypeOf('function');
    if (!module.sealMacOwnedProcess) return;

    const handle: LiveProcessHandle = { pid: 4242, exitCode: null, signalCode: null, killed: false };
    const proof: NativePeerProofPort = {
      async capture() { return { sec: '1700000000', usec: '7' }; },
      async current() { return 'OWNED'; },
      async peer() { return 'OWNED'; },
    };
    const input = { role: 'tunnel' as const, uid: 501, generation: 'tunnel-gen',
      releaseDigest: 'a'.repeat(64), executable: { dev: 11n, ino: 22n } };
    const seal = await module.sealMacOwnedProcess(handle, input, proof, new AbortController().signal);
    expect(seal?.child).toEqual({ role: 'tunnel', pid: 4242, uid: 501,
      startIdentity: '1700000000.7', generation: 'tunnel-gen', releaseDigest: 'a'.repeat(64) });
    expect(seal?.identity.executable).toEqual({ dev: 11n, ino: 22n });

    input.generation = 'mutated';
    input.executable.ino = 99n;
    expect(seal?.child.generation).toBe('tunnel-gen');
    expect(seal?.identity.executable.ino).toBe(22n);
  });

  it('fails closed for an invalid role supplied through an untyped boundary', async () => {
    const module = await import('./adapters/owned-process.js') as unknown as {
      sealMacOwnedProcess?: (...args: unknown[]) => Promise<MacProcessSeal | null>;
    };
    expect(module.sealMacOwnedProcess).toBeTypeOf('function');
    if (!module.sealMacOwnedProcess) return;
    const proof: NativePeerProofPort = {
      async capture() { return { sec: '1', usec: '1' }; },
      async current() { return 'OWNED'; },
      async peer() { return 'OWNED'; },
    };
    await expect(module.sealMacOwnedProcess(
      { pid: 2, exitCode: null, signalCode: null, killed: false },
      { role: 'other', uid: 501, generation: 'g', releaseDigest: 'a'.repeat(64), executable: { dev: 1n, ino: 2n } },
      proof, new AbortController().signal,
    )).resolves.toBeNull();
  });
});
