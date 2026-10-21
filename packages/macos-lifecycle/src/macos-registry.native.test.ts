import { execFile } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parseDisabledOverrides, parseJobPresence, type CommandObservation } from './adapters/macos-service-probes.js';

describe.skipIf(process.platform !== 'darwin')('native registry format contract', () => {
  it.each(['core', 'tunnel', 'disabled'] as const)('recognizes actual %s output without logging service details', async probe => {
    const args = probe === 'disabled' ? ['print-disabled', 'system'] : ['print', `system/com.haar.gram-agent.${probe}`];
    const raw = await new Promise<CommandObservation>(resolve => {
      execFile('/bin/launchctl', args, { encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024,
        env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C' } }, (error, stdout, stderr) => {
        resolve({ code: error && typeof error.code === 'number' ? error.code : error ? 255 : 0, stdout, stderr });
      });
    });
    const parsed = probe === 'disabled' ? parseDisabledOverrides(raw) : parseJobPresence(raw, probe);
    if (parsed === null || parsed === 'unknown') {
      // Ephemeral CI diagnostic: no service names, paths, environment or full output.
      console.info('NATIVE_REGISTRY_FORMAT', JSON.stringify({ probe, code: raw.code,
        stdoutLength: raw.stdout.length, stderrLength: raw.stderr.length,
        header: probe === 'disabled' ? raw.stdout.split('\n')[0]?.slice(0, 80) : undefined,
        valueWords: probe === 'disabled' ? [...new Set([...raw.stdout.matchAll(/=>[ \t]+([A-Za-z]+)/gu)].map(m => m[1]))] : undefined,
        notFoundShape: raw.stderr.replace(/"[^"\n]*"/gu, '"<label>"').slice(0, 250) }));
    }
    expect(parsed).not.toBeNull();
    expect(parsed).not.toBe('unknown');
  });
});
