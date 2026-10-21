import { chmodSync, copyFileSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { LinuxIsolatedProcessSpawner, type SpawnRequest } from '@gram/shell';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function lab(timeoutMs = 5_000) {
  // Parent canaries really exist and are readable outside the production mount
  // profile. The separate original #208 cases prove EACCES on faithful mounts.
  const root = mkdtempSync('/tmp/gram-production-profile-'); roots.push(root);
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  const outside = join(root, 'controller-file'); writeFileSync(outside, 'synthetic-controller-only');
  expect(readFileSync(outside, 'utf8')).toBe('synthetic-controller-only');
  const spawner = new LinuxIsolatedProcessSpawner({ workspaceForTask: (id) => id === 'task' ? { workspace, identity: 'lab-v1' } : undefined, timeoutMs });
  const run = (source: string, category: SpawnRequest['category'] = 'VERIFICATION') => spawner.spawn({
    taskId: 'task', cwd: workspace, category, executable: process.execPath, args: ['-e', source],
    env: { HOME: root, PATH: root, BASH_ENV: join(root, 'evil-startup'), WSL_INTEROP: '/run/WSL/fake',
      GITHUB_TOKEN: 'fake-only-do-not-inherit' },
  });
  return { root, workspace, outside, spawner, run };
}

it('production profile omits host files, Windows paths and host proc even for category GIT', async () => {
  const f = lab();
  const paths = [f.outside, '/mnt/c', '/init', '/sys', '/run/WSL', '/usr/lib/wsl/lib', `/proc/${process.pid}/environ`];
  const result = await f.run(`const fs=require('fs');console.log(JSON.stringify(${JSON.stringify(paths)}.map(p=>fs.existsSync(p))))`, 'GIT');
  expect(result.exitCode, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([false, false, false, false, false, false, false]);
});

it('clears host startup and credential authority while genuine non-login Bash and npm run', async () => {
  const f = lab();
  const marker = join(f.workspace, 'startup-was-loaded');
  writeFileSync(join(f.root, 'evil-startup'), `touch ${marker}\n`);
  writeFileSync(join(f.workspace, 'package.json'), JSON.stringify({ scripts: {
    test: 'node -e "process.exit(process.env.GITHUB_TOKEN || process.env.WSL_INTEROP || process.env.BASH_ENV ? 9 : 0)"',
  } }));
  const result = await f.spawner.spawn({ taskId: 'task', cwd: f.workspace, category: 'VERIFICATION',
    shellText: 'npm run test', env: { HOME: f.root, PATH: f.root, BASH_ENV: join(f.root, 'evil-startup') } });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(existsSync(marker)).toBe(false);
});

it('runs the pinned pnpm offline without a controller cache or Corepack download', async () => {
  const f = lab();
  writeFileSync(join(f.workspace, 'package.json'), JSON.stringify({
    packageManager: 'pnpm@10.34.5', scripts: { test: 'node -e "console.log(42)"' },
  }));
  const result = await f.spawner.spawn({ taskId: 'task', cwd: f.workspace, category: 'VERIFICATION',
    shellText: 'pnpm --version && pnpm run test', env: {} });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain('10.34.5');
  expect(result.stdout).toContain('42');
});

it('denies a real host pathname socket deliberately placed inside the task worktree', async () => {
  const f = lab(); const socket = join(f.workspace, 'host-control.sock');
  let accepted = 0;
  const server = createServer((connection) => { accepted++; connection.end(); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  try {
    // A working outside positive control distinguishes denial from a dead server.
    const { createConnection } = await import('node:net');
    await new Promise<void>((resolve, reject) => {
      const client = createConnection(socket); client.once('error', reject); client.once('end', resolve); client.resume();
    });
    expect(accepted).toBe(1);
    const result = await f.run(`const c=require('net').createConnection(${JSON.stringify(socket)});c.on('error',e=>{console.log(e.code);process.exit(e.code==='EPERM'?0:9)});c.on('connect',()=>process.exit(8))`);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('EPERM'); expect(accepted).toBe(1);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

it('denies executing a copied workspace binary with a working outside executable control', async () => {
  const f = lab();
  copyFileSync('/usr/bin/true', join(f.workspace, 'payload'));
  const result = await f.run("try{require('child_process').execFileSync('./payload');process.exit(8)}catch(e){console.log(e.code);process.exit(e.code==='EACCES'?0:9)}");
  expect(result.exitCode, result.stderr).toBe(0); expect(result.stdout.trim()).toBe('EACCES');
});

it('runs a genuine npm Node CLI while preventing its executable inode from being rewritten', async () => {
  const f = lab();
  const bin = join(f.workspace, 'node_modules', '.bin'); mkdirSync(bin, { recursive: true });
  const cli = join(f.workspace, 'node_modules', 'lab', 'cli.js'); mkdirSync(join(f.workspace, 'node_modules', 'lab'));
  writeFileSync(cli, '#!/usr/bin/env node\n' +
    "try{require('fs').writeFileSync(__filename,'MZ');process.exit(8)}catch(e){if(e.code!=='EROFS')process.exit(9)}\n" +
    "require('fs').writeFileSync('cli-ran','yes')\n");
  chmodSync(cli, 0o755); symlinkSync('../lab/cli.js', join(bin, 'lab-cli'));
  writeFileSync(join(f.workspace, 'package.json'), '{"scripts":{"test":"lab-cli"}}');
  const result = await f.spawner.spawn({ taskId: 'task', cwd: f.workspace, category: 'VERIFICATION',
    shellText: 'npm run test', env: {} });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(readFileSync(join(f.workspace, 'cli-ran'), 'utf8')).toBe('yes');
  expect(readFileSync(cli, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
});

it('runs a real pnpm TypeScript shell stub backed by shared package files without granting their inodes EXEC', async () => {
  const f = lab(15_000);
  const modules = join(f.workspace, 'node_modules');
  const pkg = join(modules, '.pnpm', 'typescript-fixture', 'node_modules', 'typescript');
  const require = createRequire(import.meta.url);
  const source = realpathSync(require.resolve('typescript/package.json'));
  cpSync(join(source, '..'), pkg, { recursive: true });
  const bin = join(modules, '.bin'); mkdirSync(bin, { recursive: true });
  symlinkSync('.pnpm/typescript-fixture/node_modules/typescript', join(modules, 'typescript'));
  for (const name of ['package.json', 'bin/tsc']) {
    linkSync(join(pkg, name), join(f.root, name.replace('/', '-')));
  }
  // This is the package-manager shell-stub shape, not an executable Node file.
  const stub = join(bin, 'tsc');
  const original = '#!/bin/sh\nexec node "$(dirname "$0")/../typescript/bin/tsc" "$@"\n';
  writeFileSync(stub, original, { mode: 0o755 });
  writeFileSync(join(f.workspace, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.34.5',
    devDependencies: { typescript: '*' }, scripts: { build: 'tsc --strict --noEmit counter.ts' } }));
  writeFileSync(join(f.workspace, 'counter.ts'), 'export const increment = (n: number): number => n + 1;\n');
  copyFileSync('/usr/bin/true', join(f.workspace, 'copied-elf'));
  const result = await f.spawner.spawn({ taskId: 'task', cwd: f.workspace, category: 'VERIFICATION',
    shellText: 'pnpm run build && node -e "for(const p of [\'node_modules/.bin/tsc\',\'node_modules/typescript/bin/tsc\']){try{require(\'fs\').writeFileSync(p,\'MZ\');process.exit(8)}catch(e){if(e.code!==\'EROFS\')throw e}}try{require(\'child_process\').execFileSync(\'./copied-elf\');process.exit(9)}catch(e){if(e.code!==\'EACCES\')throw e}"', env: {} });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(readFileSync(stub, 'utf8')).toBe(original);
  expect(readFileSync(join(pkg, 'bin/tsc'), 'utf8')).toBe(readFileSync(join(f.root, 'bin-tsc'), 'utf8'));
});

it('fences a detached descendant when namespace init exits normally', async () => {
  const f = lab();
  const child = "const fs=require('fs');let n=0;const t=setInterval(()=>{fs.writeFileSync('ticks',String(++n));if(n===20)clearInterval(t)},40)";
  const result = await f.run(`require('child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached:true,stdio:'ignore'}).unref();setTimeout(()=>process.exit(0),180)`);
  expect(result.exitCode, result.stderr).toBe(0);
  const before = readFileSync(join(f.workspace, 'ticks'), 'utf8'); expect(Number(before)).toBeGreaterThan(0);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(readFileSync(join(f.workspace, 'ticks'), 'utf8')).toBe(before);
});

it.each(['outside-symlink', 'too-many'])('rejects unsafe package CLI admission: %s', async (kind) => {
  const f = lab(); const bin = join(f.workspace, 'node_modules', '.bin'); mkdirSync(bin, { recursive: true });
  const file = join(f.workspace, 'cli.js'); writeFileSync(file, '#!/usr/bin/env node\nprocess.exit(0)\n'); chmodSync(file, 0o755);
  if (kind === 'outside-symlink') symlinkSync(f.outside, join(bin, 'tool'));
  if (kind === 'too-many') for (let i = 0; i < 257; i++) symlinkSync('../../cli.js', join(bin, `tool-${i}`));
  await expect(f.run("require('fs').writeFileSync('started','bad')")).rejects.toThrow();
  expect(existsSync(join(f.workspace, 'started'))).toBe(false);
});

it('rejects an unregistered shell stub before starting any workload', async () => {
  const f = lab(); const bin = join(f.workspace, 'node_modules', '.bin'); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'tool'), '#!/bin/sh\necho bad > started\n', { mode: 0o755 });
  await expect(f.run("require('fs').writeFileSync('started','bad')")).rejects.toThrow();
  expect(existsSync(join(f.workspace, 'started'))).toBe(false);
});

it('does not grant workspace execution to a native package entrypoint', async () => {
  const f = lab(); const bin = join(f.workspace, 'node_modules', '.bin'); mkdirSync(bin, { recursive: true });
  const target = join(bin, 'tool');
  copyFileSync('/usr/bin/true', target);
  const result = await f.run("try{require('child_process').execFileSync('./node_modules/.bin/tool');process.exit(8)}catch(e){process.exit(e.code==='EACCES'?0:9)}");
  expect(result.exitCode, result.stderr).toBe(0); expect(existsSync(join(f.workspace, 'started'))).toBe(false);
});

it('cannot replace an admitted CLI executable through its shared-store hardlink alias', async () => {
  const f = lab(); const bin = join(f.workspace, 'node_modules', '.bin'); mkdirSync(bin, { recursive: true });
  const cli = join(bin, 'tool'); const alias = join(f.root, 'store-alias');
  writeFileSync(cli, '#!/usr/bin/env node\nrequire("fs").writeFileSync("snapshot-ran","yes")\n', { mode: 0o755 });
  linkSync(cli, alias);
  class RewritingAlias extends LinuxIsolatedProcessSpawner {
    protected override argumentsFor(...args: Parameters<LinuxIsolatedProcessSpawner['argumentsFor']>): string[] {
      const command = super.argumentsFor(...args);
      writeFileSync(alias, readFileSync('/usr/bin/true'));
      return command;
    }
  }
  const spawner = new RewritingAlias({ workspaceForTask: () => ({ workspace: f.workspace, identity: 'lab-v1' }) });
  const result = await spawner.spawn({ taskId: 'task', cwd: f.workspace, category: 'VERIFICATION',
    shellText: './node_modules/.bin/tool', env: {} });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(readFileSync(join(f.workspace, 'snapshot-ran'), 'utf8')).toBe('yes');
  expect(readFileSync(alias).subarray(0, 4)).toEqual(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
});

it('fences the entire PID namespace before returning a command deadline failure', async () => {
  const f = lab(400);
  await expect(f.run("setInterval(()=>require('fs').writeFileSync('ticks',String(Date.now())),30)"))
    .rejects.toThrow('deadline exceeded');
  const before = readFileSync(join(f.workspace, 'ticks'), 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(readFileSync(join(f.workspace, 'ticks'), 'utf8')).toBe(before);
});

it('stops the namespace when its persisted authorization is revoked during execution', async () => {
  const f = lab(); let authorized = true;
  const spawner = new LinuxIsolatedProcessSpawner({ workspaceForTask: () => authorized ? { workspace: f.workspace, identity: 'lab-v1' } : undefined });
  const result = spawner.spawn({ taskId: 'task', cwd: f.workspace, category: 'VERIFICATION',
    executable: process.execPath, args: ['-e', "setInterval(()=>require('fs').writeFileSync('ticks',String(Date.now())),30);setTimeout(()=>process.exit(0),800)"], env: {} });
  const revoke = setTimeout(() => { authorized = false; }, 250);
  try { await expect(result).rejects.toThrow('authorization was lost'); }
  finally { clearTimeout(revoke); }
  const before = readFileSync(join(f.workspace, 'ticks'), 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(readFileSync(join(f.workspace, 'ticks'), 'utf8')).toBe(before);
});

it('rejects an unavailable root-owned entry without executing a workload marker', async () => {
  const f = lab();
  const absent = new LinuxIsolatedProcessSpawner({ workspaceForTask: () => ({ workspace: f.workspace, identity: 'lab-v1' }),
    entryPath: '/usr/local/libexec/gram-nonexistent-entry-for-test' });
  await expect(absent.spawn({ taskId: 'task', cwd: f.workspace, category: 'VERIFICATION',
    executable: process.execPath, args: ['-e', "require('fs').writeFileSync('started','bad')"], env: {} })).rejects.toThrow();
  expect(existsSync(join(f.workspace, 'started'))).toBe(false);
});

it('rejects a task-writable toolchain before executing repository code', async () => {
  const f = lab();
  const untrusted = new LinuxIsolatedProcessSpawner({ workspaceForTask: () => ({ workspace: f.workspace, identity: 'lab-v1' }), runtimeRoot: f.root });
  await expect(untrusted.spawn({ taskId: 'task', cwd: f.workspace, category: 'VERIFICATION',
    executable: process.execPath, args: ['-e', "require('fs').writeFileSync('started','bad')"], env: {} }))
    .rejects.toThrow('root-owned');
  expect(existsSync(join(f.workspace, 'started'))).toBe(false);
});

it('rechecks a copied authorization generation after admission and before any workload starts', async () => {
  const f = lab(); const binding = { workspace: f.workspace, identity: 'initial-generation' };
  class RevokingAdmission extends LinuxIsolatedProcessSpawner {
    protected override argumentsFor(workspace: string, runtime: string, entry: string, request: SpawnRequest): string[] {
      const args = super.argumentsFor(workspace, runtime, entry, request);
      binding.identity = 'replacement-generation';
      return args;
    }
  }
  const spawner = new RevokingAdmission({ workspaceForTask: () => binding });
  await expect(spawner.spawn({ taskId: 'task', cwd: f.workspace, category: 'VERIFICATION',
    executable: process.execPath, args: ['-e', "require('fs').writeFileSync('started','bad')"], env: {} }))
    .rejects.toThrow('authorization was lost');
  expect(existsSync(join(f.workspace, 'started'))).toBe(false);
});
