import { describe, expect, it } from 'vitest';
import { createLaunchctlServices, LAUNCHCTL_BIN, launchctlVector, parsePrintState } from './launchctl.js';
import { labels } from '../contracts.js';

describe('launchctl fixed vectors', () => {
  it('produces exact /bin/launchctl vectors for fixed labels only', () => {
    expect(launchctlVector('print', 'core')).toEqual([LAUNCHCTL_BIN, 'print', `system/${labels.core}`]);
    expect(launchctlVector('bootstrap', 'core')[0]).toBe('/bin/launchctl');
    expect(launchctlVector('bootout', 'tunnel')).toEqual([LAUNCHCTL_BIN, 'bootout', `system/${labels.tunnel}`]);
    expect(launchctlVector('disable', 'core')).toEqual([LAUNCHCTL_BIN, 'disable', `system/${labels.core}`]);
    // @ts-expect-error fixed roles only
    expect(() => launchctlVector('print', 'evil')).toThrow();
  });
});

describe('parsePrintState distinctions', () => {
  it('absent vs permission vs parse vs os', () => {
    const label = labels.core;
    expect(parsePrintState('core', { code: 113, stdout: '', stderr: `Could not find service "${label}" in domain for system\n` })).toBe('absent');
    expect(parsePrintState('core', { code: 1, stdout: '', stderr: 'Operation not permitted' })).toBe('permission-error');
    expect(parsePrintState('core', { code: 0, stdout: 'garbage', stderr: '' })).toBe('parse-error');
    expect(parsePrintState('core', { code: 99, stdout: '', stderr: 'boom' })).toBe('os-error');
  });
});

describe('stop disables before bootout and verifies', () => {
  it('absent is OK without mutations', async () => {
    const seen: string[][] = [];
    const svc = createLaunchctlServices(async (argv) => {
      seen.push([...argv]);
      return { code: 113, stdout: '', stderr: `Could not find service "${labels.core}" in domain for system\n` };
    });
    expect(await svc.stop('core')).toEqual({ ok: true, code: 'OK' });
    expect(seen.length).toBe(1);
    expect(seen[0][1]).toBe('print');
  });

  it('present requires disable then bootout then absent', async () => {
    const order: string[] = [];
    let prints = 0;
    const svc = createLaunchctlServices(async (argv) => {
      order.push(argv[1]);
      if (argv[1] === 'print') {
        prints++;
        if (prints === 1) return { code: 0, stdout: `system/${labels.core} = {\n}\n`, stderr: '' };
        return { code: 113, stdout: '', stderr: `Could not find service "${labels.core}" in domain for system\n` };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    expect(await svc.stop('core')).toEqual({ ok: true, code: 'OK' });
    expect(order).toEqual(['print', 'disable', 'bootout', 'print']);
  });
});
