import { describe, expect, it } from 'vitest';
import { parseCoreStartJob, createSystemFreshPublishedResumePorts } from './a-published-resume-system.js';
import type { LaunchctlObservation } from './adapters/launchctl.js';
const present = (body: string): LaunchctlObservation => ({
  code: 0,
  stderr: '',
  stdout: 'system/com.haar.gram-agent.core = {\n' + body + '}\n',
});
describe('fixed system recovery composition without native actions', () => {
  it('extracts one exact fixed-label job association, not PID ownership', () => {
    expect(parseCoreStartJob(present('\tpid = 4242\n'))).toEqual({ state: 'present', pid: 4242 });
    expect(
      parseCoreStartJob({
        code: 113,
        stdout: '',
        stderr: 'Bad request.\nCould not find service "com.haar.gram-agent.core" in domain for system\n',
      }),
    ).toEqual({ state: 'absent' });
  });
  it.each(['\tpid = 0\n', '\tpid = 2147483648\n', '\tpid = 42\n\tpid = 43\n', '\t\tpid = 42\n'])(
    'refuses ambiguous or invalid fixed job identity %j',
    (body) => {
      expect(parseCoreStartJob(present(body))).toBeNull();
    },
  );
  it('refuses another label and permission failures', () => {
    expect(parseCoreStartJob({ ...present('\tpid = 42\n'), stdout: 'system/foreign = {\n\tpid = 42\n}\n' })).toBeNull();
    expect(parseCoreStartJob({ code: 1, stdout: '', stderr: 'Operation not permitted' })).toBeNull();
  });
  it.skipIf(process.geteuid?.() === 0)(
    'does not authorize the ordinary caller or perform IO during construction',
    async () => {
      const ports = createSystemFreshPublishedResumePorts({
        manifestDigest: 'a'.repeat(64),
        journalDigest: 'b'.repeat(64),
        releaseDigest: 'c'.repeat(64),
      });
      expect(await ports.authorizeLocalAdmin()).toBe(false);
    },
  );
});
