import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SecretRedactor } from '@gram/secrets';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOwnerWorkspaceRuntime, parseOwnerWorkspaceConfig } from './owner-workspace-runtime.js';
import type { NativeWorkspaceRequest, NativeWorkspaceTransport } from './windows-workspace-client.js';

// Synthetic installed provenance and native replies test composition only. These
// mocks provide no evidence of native containment or actual root provisioning.
const fixture = vi.hoisted(() => ({ trustedConfig: '', configFds: new Set<number>(), calls: [] as string[],
  read: undefined as (() => Promise<void>) | undefined, mutation: undefined as (() => Promise<void>) | undefined,
  afterMutation: undefined as (() => void) | undefined, nativeMutationPaths: [] as string[],
  rootIdentity: '7:1', omitted: false as boolean | undefined, protectedPaths: [] as string[], protectedMutationPaths: [] as string[] }));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs,
    openSync(...args: Parameters<typeof fs.openSync>) {
      const fd = fs.openSync(...args);if (args[0] === fixture.trustedConfig) fixture.configFds.add(fd);return fd;
    },
    closeSync(fd: number) {fixture.configFds.delete(fd);return fs.closeSync(fd);},
    fstatSync(fd: number, options?: { bigint?: boolean }) {
      const st = fs.fstatSync(fd, options as { bigint: true });
      return fixture.configFds.has(fd) ? Object.assign(st, { uid: typeof st.uid === 'bigint' ? 0n : 0 }) : st;
    },
    lstatSync(path: string, options?: { bigint?: boolean }) {
      const st = fs.lstatSync(path, options as { bigint: true });
      if (fixture.trustedConfig.startsWith(path === '/' ? '/' : path + '/')) {
        Object.assign(st, { uid: typeof st.uid === 'bigint' ? 0n : 0, mode: Number(st.mode) & ~0o022 });
      }
      return st;
    },
  };
});
vi.mock('./posix-workspace-transport.js', () => ({
  FixedPosixWorkspaceTransport: class {
    async run(operation: NativeWorkspaceRequest) {
      fixture.nativeMutationPaths = [...operation.protectedMutationPaths ?? []];
      fixture.calls.push(`${operation.operation}:${operation.path}`);
      if (operation.operation === 'mkdir') {await fixture.mutation?.();fixture.afterMutation?.();}
      if (operation.operation === 'read') {await fixture.read?.();return { ok: true, rootIdentity: fixture.rootIdentity, kind: 'file', identity: '7:3', base64: 'aGk=', bytes: 2 };}
      if (operation.operation === 'list') return { ok: true, rootIdentity: fixture.rootIdentity, entries: [], omitted: fixture.omitted };
      return { ok: true, rootIdentity: fixture.rootIdentity, kind: 'directory', identity: operation.path === '.' ? fixture.rootIdentity : '7:2' };
    }
  },
  PosixWorkspaceClient: class {
    constructor(private options: { protectedPaths: string[]; protectedMutationPaths: string[]; transport: NativeWorkspaceTransport; rootPath: string }) {
      fixture.protectedPaths = options.protectedPaths;fixture.protectedMutationPaths = options.protectedMutationPaths;
    }
    async invoke(_root: string, operation: { operation: string; path: string }) {
      return this.options.transport.run({ ...operation, root: this.options.rootPath, protectedPaths: this.options.protectedPaths,
        protectedMutationPaths: this.options.protectedMutationPaths } as NativeWorkspaceRequest);
    }
  },
}));
vi.mock('./windows-workspace-transport.js', () => ({
  FixedWindowsWorkspaceTransport: class {
    async run(operation: NativeWorkspaceRequest) {
      fixture.nativeMutationPaths = [...operation.protectedMutationPaths ?? []];
      fixture.calls.push(`${operation.operation}:${operation.path}`);
      if (operation.operation === 'stat') return { ok: true, rootIdentity: fixture.rootIdentity, kind: 'directory', identity: fixture.rootIdentity };
      return { ok: true, rootIdentity: fixture.rootIdentity };
    }
  },
}));

const pin = { path: '/usr/local/libexec/fixture', sha256: 'a'.repeat(64) };
function config() {
  return { version: 1, roots: { home: { label: 'Home', kind: 'wsl-directory', wslPath: '/home/owner', writable: true } },
    posix: { artifacts: { bubblewrap: pin, node: pin, entry: pin, worker: pin, native: pin },
      recoveryBase: '/var/lib/gram/capture', recoveryRoots: { home: { path: '/home/vault', identity: '1:2' } } } };
}

describe('trusted owner workspace config', () => {
  it('accepts a bounded strict configuration and snapshots caller objects', () => {
    const input = config();const parsed = parseOwnerWorkspaceConfig(input);
    input.roots.home.wslPath = '/changed';
    expect(parsed.roots.home?.wslPath).toBe('/home/owner');
    expect(Object.isFrozen(parsed.roots.home)).toBe(true);
  });
  it.each([
    null, {}, { ...config(), version: 2 }, { ...config(), executable: '/bin/sh' },
    { ...config(), roots: {} }, { ...config(), roots: { home: { ...config().roots.home, extra: true } } },
    { ...config(), posix: { ...config().posix, artifacts: { ...config().posix.artifacts, shell: pin } } },
    { ...config(), posix: { ...config().posix, recoveryRoots: {} } },
    { ...config(), posix: undefined },
    { ...config(), roots: { home: { ...config().roots.home, wslPath: '/home/../etc' } } },
    { ...config(), roots: { home: { ...config().roots.home, wslPath: '/' } } },
    { ...config(), posix: { ...config().posix, recoveryBase: '/tmp/../vault' } },
    { ...config(), posix: { ...config().posix, recoveryRoots: { home: { path: '/home/vault', identity: 'caller' } } } },
    { ...config(), posix: { ...config().posix, artifacts: { ...config().posix.artifacts, node: { ...pin, sha256: 'bad' } } } },
  ])('rejects invalid or caller-extensible authority %#', value => {
    expect(() => parseOwnerWorkspaceConfig(value)).toThrow('Owner workspace runtime denied');
  });
  it('requires each Windows root and recovery pin to have a fixed Windows backend', () => {
    const input = { version: 1, roots: { drive: { label: 'C', kind: 'windows-drive', wslPath: '/mnt/c', windowsPath: 'C:\\', writable: true } } };
    expect(() => parseOwnerWorkspaceConfig(input)).toThrow();
    const native = { ...pin, path: '/usr/local/libexec/helper.exe', expectedOwnerSid: 'S-1-5-21-1' };
    const valid = { ...input, windows: { helper: pin, ownerPresence: native, viewer: native,
      protectedPaths: ['C:\\Gram'], protectedMutationPaths: [], recoveryRoots: { drive: { windowsPath: 'C:\\GramVault', identity: '1:2' } } } };
    expect(parseOwnerWorkspaceConfig(valid).roots.drive?.windowsPath).toBe('C:\\');
    expect(() => parseOwnerWorkspaceConfig({ ...valid, roots: { drive: { ...input.roots.drive, wslPath: '/mnt/d' } } })).toThrow();
  });
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  fixture.trustedConfig = '';fixture.calls.length = 0;fixture.read = undefined;fixture.mutation = undefined;fixture.afterMutation = undefined;fixture.rootIdentity = '7:1';
});
async function runtimeFixture(before?: (base: string) => void) {
  const base = mkdtempSync(join(homedir(), '.owner-runtime-'));chmodSync(base, 0o700);
  cleanups.push(async () => {rmSync(base, { recursive: true, force: true });});
  for (const part of ['root', 'root/project', 'state', 'secrets']) mkdirSync(join(base, part), { mode: 0o700 });
  fixture.trustedConfig = join(base, 'config.json');
  const input = config();input.roots.home.wslPath = join(base, 'root');
  writeFileSync(fixture.trustedConfig, JSON.stringify(input), { mode: 0o600 });
  before?.(base);
  let active: string[] = [];
  const runtime = await createOwnerWorkspaceRuntime({ configPath: fixture.trustedConfig,
    stateDirectory: join(base, 'state'), secretDirectory: join(base, 'secrets'), redactor: new SecretRedactor(),
    protectedReadPaths: [join(base, 'root/private')], protectedMutationPaths: [join(base, 'root/code')], activeMutationPaths: () => active });
  cleanups.push(() => runtime.close());
  return { base, runtime, setActive: (paths: string[]) => {active = paths;} };
}
describe('owner runtime composition with synthetic installed/native ports', () => {
  it('waits for a native filesystem mutation before admitting a repository lease', async () => {
    const { runtime } = await runtimeFixture();let release = () => {};let admitted = false;
    fixture.mutation = () => new Promise<void>(resolve => {release = resolve;});
    const mutation = runtime.core.mkdir({ root: 'home', path: 'project/new' });
    await vi.waitFor(() => expect(fixture.calls).toContain('mkdir:project/new'));
    const lease = runtime.withRepositoryLeaseAdmission(async () => {admitted = true;return 'lease';});
    await new Promise(resolve => setTimeout(resolve, 20));expect(admitted).toBe(false);
    release();expect((await mutation).state).toBe('APPLIED');expect(await lease).toBe('lease');
  });
  it('queues filesystem mutations behind lease admission and rechecks the resulting active lock', async () => {
    const { base, runtime, setActive } = await runtimeFixture();let release = () => {};let entered = false;
    const lease = runtime.withRepositoryLeaseAdmission(async () => {
      entered = true;await new Promise<void>(resolve => {release = resolve;});setActive([join(base, 'root/project')]);
    });
    await vi.waitFor(() => expect(entered).toBe(true));
    const mutation = runtime.core.mkdir({ root: 'home', path: 'project/new' });
    await new Promise(resolve => setTimeout(resolve, 20));expect(fixture.calls).not.toContain('mkdir:project/new');
    release();await lease;expect((await mutation).state).toBe('DENIED');
    expect(fixture.calls).not.toContain('mkdir:project/new');
  });
  it('releases failed lease admissions and drains admitted acquisition before closing', async () => {
    const { runtime } = await runtimeFixture();
    await expect(runtime.withRepositoryLeaseAdmission(async () => {throw new Error('lease unavailable');})).rejects.toThrow('lease unavailable');
    expect((await runtime.core.mkdir({ root: 'home', path: 'after-failure' })).state).toBe('APPLIED');
    let release = () => {};let entered = false;
    const lease = runtime.withRepositoryLeaseAdmission(async () => {
      entered = true;await new Promise<void>(resolve => {release = resolve;});
    });
    await vi.waitFor(() => expect(entered).toBe(true));
    await expect(runtime.core.read({ root: 'home', path: 'file' })).resolves.toMatchObject({ content: 'hi' });
    let drained = false;const close = runtime.close().then(() => {drained = true;});
    await Promise.resolve();expect(drained).toBe(false);
    await expect(runtime.withRepositoryLeaseAdmission(async () => 'new')).rejects.toThrow();
    release();await lease;await close;expect(drained).toBe(true);
  });
  it('forwards current active scopes as relative native mutation protections on every request', async () => {
    const { base, runtime, setActive } = await runtimeFixture();setActive([join(base, 'root/project')]);
    await runtime.core.read({ root: 'home', path: 'file' });
    expect(fixture.nativeMutationPaths).toContain('project');
    setActive([join(base, 'root/other')]);
    await runtime.core.mkdir({ root: 'home', path: 'allowed' });
    expect(fixture.nativeMutationPaths).toContain('other');expect(fixture.nativeMutationPaths).not.toContain('project');
  });
  it('forwards Windows scopes to native identity enforcement even when caller spelling differs', async () => {
    const { runtime, setActive } = await runtimeFixture(() => {
      const native = { ...pin, path: '/usr/local/libexec/helper.exe', expectedOwnerSid: 'S-1-5-21-1' };
      writeFileSync(fixture.trustedConfig, JSON.stringify({ version: 1,
        roots: { home: { label: 'C', kind: 'windows-drive', wslPath: '/mnt/c', windowsPath: 'C:\\', writable: true } },
        windows: { helper: { path: native.path, sha256: native.sha256 }, ownerPresence: native, viewer: native,
          protectedPaths: [], protectedMutationPaths: [], recoveryRoots: { home: { windowsPath: 'C:\\Vault', identity: '1:2' } } } }));
    });
    setActive(['/mnt/c/Project']);
    // The synthetic helper observes protections; native alias denial itself is
    // covered by native tests, not claimed by this composition fixture.
    await runtime.core.mkdir({ root: 'home', path: 'PROJEC~1/new' });
    expect(fixture.nativeMutationPaths).toContain('C:\\Project');
  });
  it('denies a root replacement before native dispatch without quarantining later valid mutations', async () => {
    const { base, runtime } = await runtimeFixture();const root = join(base, 'root');const saved = join(base, 'saved');
    renameSync(root, saved);mkdirSync(root, { mode: 0o700 });
    expect((await runtime.core.mkdir({ root: 'home', path: 'denied' })).state).toBe('DENIED');
    expect(fixture.calls).not.toContain('mkdir:denied');
    rmSync(root, { recursive: true });renameSync(saved, root);
    expect((await runtime.core.mkdir({ root: 'home', path: 'allowed' })).state).toBe('APPLIED');
  });
  it('retains unresolved quarantine when root replacement is discovered after a native mutation reply', async () => {
    const { base, runtime } = await runtimeFixture();
    fixture.afterMutation = () => {renameSync(join(base, 'root'), join(base, 'saved'));mkdirSync(join(base, 'root'), { mode: 0o700 });};
    expect((await runtime.core.mkdir({ root: 'home', path: 'uncertain' })).state).toBe('NEEDS_RECONCILIATION');
    fixture.afterMutation = undefined;rmSync(join(base, 'root'), { recursive: true });renameSync(join(base, 'saved'), join(base, 'root'));
    await expect(runtime.core.mkdir({ root: 'home', path: 'blocked' })).rejects.toThrow();
    expect(fixture.calls).not.toContain('mkdir:blocked');
  });
  it('allows Git inspection on a read-only root but denies registered command preparation', async () => {
    const { base, runtime } = await runtimeFixture(() => {
      const input = JSON.parse(readFileSync(fixture.trustedConfig, 'utf8')) as ReturnType<typeof config>;
      input.roots.home.writable = false;writeFileSync(fixture.trustedConfig, JSON.stringify(input));
    });
    const repository = { githubRepositoryId: 1, owner: 'owner', name: 'fixture', defaultBranch: 'main',
      localBasePath: join(base, 'root/project'), commands: {}, profile: {}, createdAt: '', updatedAt: '' };
    await expect(runtime.withProject({ root: 'home', path: 'project' }, async () => 'read')).resolves.toBe('read');
    await expect(runtime.withRegisteredProject(repository, async () => 'write')).rejects.toThrow();
  });
  it('allows an ancestor root while subtracting mandatory controller-private regions from its native backend', async () => {
    await runtimeFixture(base => {
      const input = config();input.roots.home.wslPath = base;
      writeFileSync(fixture.trustedConfig, JSON.stringify(input));
    });
    expect(fixture.protectedPaths).toEqual(expect.arrayContaining(['config.json', 'state', 'secrets', 'root/private']));
    expect(fixture.protectedMutationPaths).toEqual(expect.arrayContaining(['config.json', 'state', 'secrets', 'root/code']));
  });
  it('rejects a configured root inside mandatory controller-private storage', async () => {
    await expect(runtimeFixture(base => {
      const input = config();input.roots.home.wslPath = join(base, 'state');
      writeFileSync(fixture.trustedConfig, JSON.stringify(input));
    })).rejects.toThrow();
  });
  it.each(['writable-config', 'hardlinked-config', 'oversized-config'])('rejects unsafe installed config metadata: %s', async kind => {
    await expect(runtimeFixture(base => {
      if (kind === 'writable-config') chmodSync(fixture.trustedConfig, 0o620);
      if (kind === 'hardlinked-config') linkSync(fixture.trustedConfig, join(base, 'config-alias'));
      if (kind === 'oversized-config') writeFileSync(fixture.trustedConfig, ' '.repeat(65537));
    })).rejects.toThrow();
  });
  it('uses a private dedicated journal, and rejects a preexisting journal symlink or hardlink', async () => {
    const { base } = await runtimeFixture();
    expect(readFileSync(join(base, 'state/owner-workspace.sqlite')).subarray(0, 16).toString()).toBe('SQLite format 3\0');
    for (const link of [symlinkSync, linkSync]) {
      await expect(runtimeFixture(base => {
        const target = join(base, 'elsewhere');writeFileSync(target, '', { mode: 0o600 });
        link(target, join(base, 'state/owner-workspace.sqlite'));
      })).rejects.toThrow();
    }
  });
  it('denies private reads and code mutations, and consults changing active repository scopes', async () => {
    const { base, runtime, setActive } = await runtimeFixture();
    await expect(runtime.core.read({ root: 'home', path: 'private/file' })).rejects.toThrow();
    expect((await runtime.core.mkdir({ root: 'home', path: 'code/new' })).state).toBe('DENIED');
    setActive([join(base, 'root/project')]);
    expect((await runtime.core.mkdir({ root: 'home', path: 'project/new' })).state).toBe('DENIED');
    expect(fixture.calls).not.toContain('mkdir:project/new');
    setActive([]);
    expect((await runtime.core.mkdir({ root: 'home', path: 'project/allowed' })).state).toBe('APPLIED');
  });
  it.each([true, undefined, false])('requires an explicitly complete native listing for Git capture: %s', async omitted => {
    const { runtime } = await runtimeFixture();fixture.omitted = omitted;
    try {
      const result = runtime.withProject({ root: 'home', path: 'project' }, async value => {
        if (!value.gitSnapshotSource) throw new Error('Missing production source');
        return value.gitSnapshotSource.list('.');
      });
      if (omitted === false) expect(await result).toEqual([]);
      else await expect(result).rejects.toThrow();
    } finally {fixture.omitted = false;}
  });
  it('pins project directories around callbacks and keeps read-only project access under an active command lease', async () => {
    const { base, runtime, setActive } = await runtimeFixture();setActive([join(base, 'root/project')]);
    const project = await runtime.withProject({ root: 'home', path: 'project' }, async value => value);
    expect(project).toEqual({ canonicalPath: join(base, 'root/project'), identity: '7:2', gitSnapshotSource: {
      verify: expect.any(Function), list: expect.any(Function), read: expect.any(Function),
    } });
    const repository = { githubRepositoryId: 1, owner: 'owner', name: 'fixture', defaultBranch: 'main',
      localBasePath: project.canonicalPath, commands: {}, profile: {}, createdAt: '', updatedAt: '' };
    expect(await runtime.withRegisteredProject(repository, async value => ({ canonicalPath: value.canonicalPath, identity: value.identity })))
      .toEqual({ canonicalPath: project.canonicalPath, identity: project.identity });
    await expect(runtime.withRegisteredProject({ ...repository, localBasePath: base }, async value => value)).rejects.toThrow();
    symlinkSync(project.canonicalPath, join(base, 'root/alias'));
    await expect(runtime.withProject({ root: 'home', path: 'alias' }, async value => value)).rejects.toThrow();
    await expect(runtime.withProject({ root: 'home', path: 'project' }, async () => {
      fixture.rootIdentity = '7:9';return 'changed';
    })).rejects.toThrow();
  });
  it('drains admitted work before closing and prevents retained core references from doing more work', async () => {
    const { runtime } = await runtimeFixture();
    let release = () => {};fixture.read = () => new Promise<void>(resolve => {release = resolve;});
    const read = runtime.core.read({ root: 'home', path: 'file' });
    await vi.waitFor(() => expect(fixture.calls).toContain('read:file'));
    let drained = false;const close = runtime.close().then(() => {drained = true;});
    await Promise.resolve();expect(drained).toBe(false);
    await expect(runtime.core.read({ root: 'home', path: 'new' })).rejects.toThrow();
    release();await read;await close;expect(drained).toBe(true);
    expect(() => runtime.core.roots()).toThrow();
    await expect(runtime.withProject({ root: 'home', path: 'project' }, async () => 'no')).rejects.toThrow();
  });
});
