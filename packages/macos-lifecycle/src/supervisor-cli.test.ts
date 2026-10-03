import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { root } from './contracts.js';
import type { SupervisorBootstrap } from './supervisor-entry.js';
import { isDirectSupervisorCli, runSupervisorCli } from './supervisor-cli.js';

const configPath = `${root}/config/service.json`;
const args = ['--role', 'core', '--config', configPath] as const;

describe('fixed launchd supervisor CLI entry', () => {
  it('recognizes only the exact direct module path', () => {
    expect(isDirectSupervisorCli('file:///tmp/supervisor-cli.js', '/tmp/supervisor-cli.js')).toBe(true);
    expect(isDirectSupervisorCli('file:///tmp/supervisor-cli.js', '/tmp/other.js')).toBe(false);
    expect(isDirectSupervisorCli('file:///tmp/supervisor-cli.js', undefined)).toBe(false);
    expect(isDirectSupervisorCli('not-a-url', '/tmp/supervisor-cli.js')).toBe(false);
    expect(isDirectSupervisorCli('file:///tmp/supervisor-cli.js', 'relative.js')).toBe(false);
  });

  it('delegates only the internal fixed grammar to the existing entry', async () => {
    const events = new EventEmitter();
    let request: unknown = null;
    const bootstrap: SupervisorBootstrap = {
      async prepare(invocation) {
        request = invocation;
        return { async run() { return 0; } };
      },
    };
    expect(await runSupervisorCli(args, bootstrap, events)).toBe(0);
    expect(request).toEqual({ role: 'core', configPath });
    expect(events.eventNames()).toEqual([]);
  });

  it('fails closed when production bootstrap trust is not supplied', async () => {
    const events = new EventEmitter();
    expect(await runSupervisorCli(args, undefined, events)).toBe(78);
    expect(events.eventNames()).toEqual([]);
  });

  it('rejects public-CLI-like commands before consulting bootstrap', async () => {
    const events = new EventEmitter();
    let prepared = 0;
    const bootstrap: SupervisorBootstrap = {
      async prepare() { prepared++; return null; },
    };
    expect(await runSupervisorCli(['status'], bootstrap, events)).toBe(64);
    expect(await runSupervisorCli(['start', 'core'], bootstrap, events)).toBe(64);
    expect(prepared).toBe(0);
    expect(events.eventNames()).toEqual([]);
  });

  it('accepts tunnel only through the same fixed config path', async () => {
    const events = new EventEmitter();
    let role = '';
    const bootstrap: SupervisorBootstrap = {
      async prepare(invocation) {
        role = invocation.role;
        return { async run() { return 1; } };
      },
    };
    expect(await runSupervisorCli(['--config', configPath, '--role', 'tunnel'], bootstrap, events)).toBe(1);
    expect(role).toBe('tunnel');
    expect(events.eventNames()).toEqual([]);
  });

  it('maps bootstrap failures without exposing provider text', async () => {
    const events = new EventEmitter();
    const bootstrap: SupervisorBootstrap = {
      async prepare() { throw new Error('SYNTHETIC_PRIVATE_BOOTSTRAP_SECRET'); },
    };
    expect(await runSupervisorCli(args, bootstrap, events)).toBe(70);
    expect(events.eventNames()).toEqual([]);
  });
});
