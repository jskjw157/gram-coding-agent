import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalWorkSession } from './session.js';

const roots: string[] = [];
function setup(
  options: { trustedLocalCode?: boolean; timeoutMs?: number; maxOutputBytes?: number; signal?: AbortSignal } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'gram-local-work-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  return { root, workspace, session: new LocalWorkSession({ workspace, ...options }) };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('local task file and Node workflow', () => {
  it('writes a script, executes it in the task folder and reads its result', async () => {
    const { session, workspace } = setup({ trustedLocalCode: true });
    session.writeText(
      'src/work.cjs',
      "require('node:fs').writeFileSync('result.txt', 'answer=42'); console.log(process.argv[2]);",
    );
    const result = await session.runNode('src/work.cjs', ['hello; $(touch NEVER)']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello; $(touch NEVER)\n');
    expect(session.readText('result.txt')).toBe('answer=42');
    expect(existsSync(join(workspace, 'NEVER'))).toBe(false);
    expect(session.history()).toEqual([{ id: 1, status: 'SUCCEEDED', exitCode: 0 }]);
  });

  it('refuses code execution unless the caller explicitly trusts the script', async () => {
    const { session, workspace } = setup();
    session.writeText('work.cjs', "require('node:fs').writeFileSync('ran', 'yes');");
    await expect(session.runNode('work.cjs')).rejects.toThrow('trusted local code');
    expect(existsSync(join(workspace, 'ran'))).toBe(false);
    expect(session.history()).toEqual([]);
  });

  it('rejects absolute paths, parent traversal, symlinks and unregistered task paths', async () => {
    const { root, workspace, session } = setup({ trustedLocalCode: true });
    const outside = join(root, 'outside.cjs');
    writeFileSync(outside, "require('node:fs').writeFileSync('ran', 'yes');");
    symlinkSync(outside, join(workspace, 'escape.cjs'));
    symlinkSync(root, join(workspace, 'outside-dir'));
    for (const path of [outside, '../outside.cjs', 'escape.cjs', 'outside-dir/outside.cjs']) {
      expect(() => session.readText(path)).toThrow();
      expect(() => session.writeText(path, 'bad')).toThrow();
      await expect(session.runNode(path)).rejects.toThrow();
    }
    expect(readFileSync(outside, 'utf8')).toContain('writeFileSync');
    expect(session.history()).toEqual([]);
  });

  it('does not overwrite an outside file via a hard link in the workspace', () => {
    const { root, workspace, session } = setup();
    const outside = join(root, 'outside.txt');
    writeFileSync(outside, 'preserve');
    linkSync(outside, join(workspace, 'alias.txt'));
    expect(() => session.writeText('alias.txt', 'changed')).toThrow();
    expect(readFileSync(outside, 'utf8')).toBe('preserve');
  });

  it('filters parent secrets and Node injection variables; redacts captured output', async () => {
    const { session } = setup({ trustedLocalCode: true });
    session.writeText(
      'env.cjs',
      "console.log(JSON.stringify({home:process.env.HOME,token:process.env.GH_TOKEN,nodeOptions:process.env.NODE_OPTIONS})); console.error('Authorization: Bearer synthetic-token');",
    );
    const before = { GH_TOKEN: process.env.GH_TOKEN, NODE_OPTIONS: process.env.NODE_OPTIONS };
    process.env.GH_TOKEN = 'synthetic-parent-secret';
    process.env.NODE_OPTIONS = '--require=/nonexistent/injection.cjs';
    try {
      const result = await session.runNode('env.cjs');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('synthetic-parent-secret');
      expect(result.stdout).not.toContain('nodeOptions');
      expect(result.stderr).toBe('Authorization: Bearer ***REDACTED***\n');
    } finally {
      for (const key of ['GH_TOKEN', 'NODE_OPTIONS'] as const) {
        if (before[key] === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = before[key];
      }
    }
  });

  it('rejects a symlink to a hard-linked file before overwriting its outside alias', () => {
    const { root, workspace, session } = setup();
    writeFileSync(join(root, 'outside.txt'), 'preserve');
    linkSync(join(root, 'outside.txt'), join(workspace, 'alias.txt'));
    symlinkSync('alias.txt', join(workspace, 'link.txt'));
    expect(() => session.writeText('link.txt', 'changed')).toThrow();
    expect(readFileSync(join(root, 'outside.txt'), 'utf8')).toBe('preserve');
  });

  it('refuses operations when the selected workspace directory has been replaced', () => {
    const { root, workspace, session } = setup();
    renameSync(workspace, join(root, 'original'));
    mkdirSync(workspace);
    expect(() => session.writeText('unexpected.txt', 'no')).toThrow('identity changed');
    expect(existsSync(join(workspace, 'unexpected.txt'))).toBe(false);
  });

  it('terminates an ordinary descendant after its parent script exits', async () => {
    const { session } = setup({ trustedLocalCode: true });
    session.writeText('child.cjs', 'setInterval(() => {}, 100);');
    session.writeText(
      'parent.cjs',
      "const child = require('node:child_process').spawn(process.execPath, ['child.cjs'], {stdio:'ignore'}); require('node:fs').writeFileSync('pid.txt', String(child.pid)); child.unref();",
    );
    expect((await session.runNode('parent.cjs')).exitCode).toBe(0);
    const pid = Number(session.readText('pid.txt'));
    expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
    let exited = false;
    for (let i = 0; i < 40; i++) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
          exited = true;
          break;
        }
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(exited).toBe(true);
  });

  it('records nonzero exit as FAILED', async () => {
    const { session } = setup({ trustedLocalCode: true });
    session.writeText('fail.cjs', 'process.exitCode = 7;');
    expect((await session.runNode('fail.cjs')).exitCode).toBe(7);
    expect(session.history()).toEqual([{ id: 1, status: 'FAILED', exitCode: 7 }]);
  });

  it('kills an indefinitely running process at its deadline and records failure', async () => {
    const { session } = setup({ trustedLocalCode: true, timeoutMs: 250 });
    session.writeText('wait.cjs', 'setInterval(() => {}, 100);');
    await expect(session.runNode('wait.cjs')).rejects.toThrow('deadline');
    expect(session.history()).toEqual([{ id: 1, status: 'FAILED', exitCode: null }]);
  });

  it('terminates excessive stdout and stderr instead of buffering without a bound', async () => {
    const { session } = setup({ trustedLocalCode: true, maxOutputBytes: 1024 });
    session.writeText(
      'flood.cjs',
      "for (;;) { process.stdout.write('x'.repeat(1024)); process.stderr.write('y'.repeat(1024)); }",
    );
    await expect(session.runNode('flood.cjs')).rejects.toThrow('output limit');
    expect(session.history()).toEqual([{ id: 1, status: 'FAILED', exitCode: null }]);
  });

  it('settles at the deadline even when a detached descendant retains output pipes', async () => {
    const { session } = setup({ trustedLocalCode: true, timeoutMs: 250 });
    session.writeText('pipe-holder.cjs', 'setTimeout(() => {}, 2000);');
    session.writeText(
      'escape-group.cjs',
      "const child = require('node:child_process').spawn(process.execPath, ['pipe-holder.cjs'], {detached:true, stdio:['ignore',1,2]}); require('node:fs').writeFileSync('detached-pid.txt', String(child.pid)); child.unref();",
    );
    const started = performance.now();
    try {
      await expect(session.runNode('escape-group.cjs')).rejects.toThrow('deadline');
      expect(performance.now() - started).toBeLessThan(1500);
    } finally {
      const pid = Number(session.readText('detached-pid.txt'));
      try {
        process.kill(-pid, 'SIGKILL');
      } catch (error) {
        expect(error).toMatchObject({ code: 'ESRCH' });
      }
    }
  });

  it('cancels the active process group through an explicit abort signal', async () => {
    const controller = new AbortController();
    const { session, workspace } = setup({ trustedLocalCode: true, timeoutMs: 2500, signal: controller.signal });
    session.writeText(
      'cancel.cjs',
      "require('node:fs').writeFileSync('pid.txt', String(process.pid)); setInterval(() => {}, 100);",
    );
    const running = session.runNode('cancel.cjs');
    const failure = expect(running).rejects.toThrow('cancelled');
    for (let i = 0; i < 100 && !existsSync(join(workspace, 'pid.txt')); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const pid = Number(session.readText('pid.txt'));
    controller.abort();
    await failure;
    let exited = false;
    for (let i = 0; i < 40; i++) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
          exited = true;
          break;
        }
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(exited).toBe(true);
    expect(session.history()).toEqual([{ id: 1, status: 'FAILED', exitCode: null }]);
  });
});
