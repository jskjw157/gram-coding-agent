import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { root } from '../contracts.js';

function enabledConfig() {
  return parseConfig({ schemaVersion: 1, mode: 'LAB_ONLY', runtimeUser: 'gram-agent',
    releaseId: 'lab-tunnel', releaseDigest: 'a'.repeat(64),
    tunnel: { enabled: true, compatibilityDigest: 'b'.repeat(64), credentialRef: 'test-tunnel-key' } });
}

describe('fixed native tunnel launch plan', () => {
  it('derives only the reviewed tunnel binary, fixed config path and nonsecret environment', async () => {
    const module = await import('./native-tunnel.js') as unknown as {
      tunnelLaunchPlan?: (config: ReturnType<typeof enabledConfig>) => {
        file: string; args: readonly string[]; cwd: string; env: Readonly<Record<string,string>>;
      };
    };
    expect(module.tunnelLaunchPlan).toBeTypeOf('function');
    if (!module.tunnelLaunchPlan) return;
    const plan = module.tunnelLaunchPlan(enabledConfig());
    const release = `${root}/releases/lab-tunnel`;
    expect(plan).toEqual({
      file: `${release}/bin/tunnel-client`,
      args: ['run', '--config', `${root}/config/tunnel-client.yaml`],
      cwd: release,
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: '/Users/gram-agent' },
    });
    expect(Object.keys(plan.env).sort()).toEqual(['HOME','LANG','LC_ALL','PATH']);
    expect(JSON.stringify(plan)).not.toMatch(/API_KEY|TOKEN|SECRET|HTTP_PROXY|NODE_OPTIONS|DYLD_/u);
  });

  it('refuses a disabled tunnel configuration instead of inventing a permissive plan', async () => {
    const module = await import('./native-tunnel.js') as unknown as {
      tunnelLaunchPlan?: (config: unknown) => unknown;
    };
    expect(module.tunnelLaunchPlan).toBeTypeOf('function');
    if (!module.tunnelLaunchPlan) return;
    const disabled = parseConfig({ schemaVersion: 1, mode: 'LAB_ONLY', runtimeUser: 'gram-agent',
      releaseId: 'lab-tunnel', releaseDigest: 'a'.repeat(64), tunnel: { enabled: false } });
    expect(() => module.tunnelLaunchPlan?.(disabled)).toThrow('TUNNEL_COMPATIBILITY_REQUIRED');
  });

  it('returns detached frozen command data', async () => {
    const module = await import('./native-tunnel.js') as unknown as {
      tunnelLaunchPlan?: (config: ReturnType<typeof enabledConfig>) => {
        file: string; args: readonly string[]; cwd: string; env: Readonly<Record<string,string>>;
      };
    };
    expect(module.tunnelLaunchPlan).toBeTypeOf('function');
    if (!module.tunnelLaunchPlan) return;
    const config = enabledConfig(); const plan = module.tunnelLaunchPlan(config);
    config.releaseId = 'changed';
    expect(plan.file).toContain('/lab-tunnel/');
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.args)).toBe(true);
    expect(Object.isFrozen(plan.env)).toBe(true);
  });
});
