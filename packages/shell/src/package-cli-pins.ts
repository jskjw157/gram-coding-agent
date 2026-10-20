import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export interface PackageCliPin {
  path: string;
  descriptor: number;
  execute?: true;
  cleanup?: () => void;
}
const CLI = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
function inside(workspace: string, file: string): string {
  const canonical = realpathSync(file);
  if (!canonical.startsWith(workspace + '/') || canonical.split('/').includes('.git'))
    throw new Error('Package command entrypoint escapes the workspace');
  return canonical;
}
const FILE_LIMIT = 1024 * 1024;
const TOTAL_LIMIT = 16 * 1024 * 1024;
interface ReadBudget { bytes: number }
function snapshot(file: string, budget: ReadBudget): { bytes: Buffer; links: number } {
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.size > FILE_LIMIT ||
      before.uid !== process.getuid?.() ||
      realpathSync(`/proc/self/fd/${descriptor}`) !== file
    )
      throw new Error('Unsafe package source');
    budget.bytes += before.size;
    if (budget.bytes > TOTAL_LIMIT) throw new Error('Package admission read byte limit exceeded');
    const buffer = Buffer.alloc(FILE_LIMIT + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(descriptor, buffer, length, buffer.length - length, length);
      if (read === 0) break;
      length += read;
    }
    const after = fstatSync(descriptor);
    if (
      length > FILE_LIMIT ||
      length !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.nlink !== after.nlink ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      realpathSync(`/proc/self/fd/${descriptor}`) !== file
    )
      throw new Error('Package source changed during admission');
    return { bytes: buffer.subarray(0, length), links: before.nlink };
  } finally {
    closeSync(descriptor);
  }
}
function manifest(file: string, budget: ReadBudget): Record<string, unknown> {
  const parsed: unknown = JSON.parse(snapshot(file, budget).bytes.toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid package manifest');
  return parsed as Record<string, unknown>;
}
function mappings(workspace: string, budget: ReadBudget): Map<string, string> {
  const modules = join(workspace, 'node_modules');
  const packages: string[] = [];
  const root = manifest(join(workspace, 'package.json'), budget);
  const names = new Set<string>();
  const optional = new Set<string>();
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const section = root[key];
    if (section === undefined) continue;
    if (!section || typeof section !== 'object' || Array.isArray(section))
      throw new Error('Invalid root dependency registrations');
    for (const [name, version] of Object.entries(section)) {
      if (!/^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(name) || typeof version !== 'string')
        throw new Error('Invalid root dependency name');
      names.add(name);
      if (key === 'optionalDependencies') optional.add(name);
      if (names.size > 256) throw new Error('Too many direct package manifests');
    }
  }
  for (const name of [...names].sort()) {
    const directory = join(modules, name);
    try {
      packages.push(inside(workspace, directory));
    } catch (error) {
      if (optional.has(name) && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
  const result = new Map<string, string>();
  for (const directory of packages) {
    const pkg = inside(workspace, directory);
    if (!lstatSync(pkg).isDirectory()) throw new Error('Package must be a directory');
    const data = manifest(join(pkg, 'package.json'), budget);
    if (data.bin === undefined) continue;
    let bins: Record<string, unknown>;
    if (typeof data.bin === 'string') {
      if (typeof data.name !== 'string') throw new Error('String bin requires a package name');
      bins = { [basename(data.name)]: data.bin };
    } else if (data.bin && typeof data.bin === 'object' && !Array.isArray(data.bin))
      bins = data.bin as Record<string, unknown>;
    else throw new Error('Invalid package bin mapping');
    for (const [name, target] of Object.entries(bins)) {
      if (
        !CLI.test(name) ||
        typeof target !== 'string' ||
        target.length > 4096 ||
        target.includes('\\') ||
        target.includes('\0')
      )
        throw new Error('Invalid package bin target');
      const selected = resolve(pkg, target);
      if (!selected.startsWith(pkg + '/')) throw new Error('Package bin escapes its package');
      const canonical = inside(workspace, selected);
      if (!canonical.startsWith(pkg + '/')) throw new Error('Package bin escapes its package');
      if (result.has(name)) throw new Error('Ambiguous package bin mapping');
      result.set(name, canonical);
      if (result.size > 256) throw new Error('Too many package bin mappings');
    }
  }
  return result;
}
function privatePin(destination: string, bytes: Buffer, execute: boolean): PackageCliPin {
  const directory = mkdtempSync(join(tmpdir(), 'gram-package-cli-'));
  const file = join(directory, 'entry.cjs');
  let descriptor: number | undefined;
  try {
    const dirIdentity = lstatSync(directory);
    if (!dirIdentity.isDirectory() || dirIdentity.uid !== process.getuid?.() || (dirIdentity.mode & 0o777) !== 0o700)
      throw new Error('Unsafe private CLI directory');
    writeFileSync(file, bytes, { flag: 'wx', mode: execute ? 0o700 : 0o600 });
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const identity = fstatSync(descriptor);
    if (
      !identity.isFile() ||
      identity.uid !== process.getuid?.() ||
      identity.nlink !== 1 ||
      (identity.mode & 0o777) !== (execute ? 0o700 : 0o600) ||
      realpathSync(`/proc/self/fd/${descriptor}`) !== file
    )
      throw new Error('Unsafe private CLI snapshot');
    let cleaned = false;
    return {
      path: destination,
      descriptor,
      ...(execute ? { execute: true as const } : {}),
      cleanup() {
        if (cleaned) return;
        const dir = lstatSync(directory);
        const current = lstatSync(file);
        if (
          dir.dev !== dirIdentity.dev ||
          dir.ino !== dirIdentity.ino ||
          dir.uid !== dirIdentity.uid ||
          (dir.mode & 0o777) !== 0o700 ||
          current.dev !== identity.dev ||
          current.ino !== identity.ino ||
          current.nlink !== 1
        )
          throw new Error('CLI cleanup identity mismatch');
        unlinkSync(file);
        rmdirSync(directory);
        cleaned = true;
      },
    };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(file);
    } catch {
      /* not created */
    }
    rmdirSync(directory);
    throw error;
  }
}
/** No original workspace/shared-store inode receives EXEC. Every returned FD
 * is a private bounded snapshot, mounted read-only by the caller. Cleanup is
 * permitted only after descriptor closure and namespace quiescence. */
export function pinPackageEntrypoints(workspace: string): PackageCliPin[] {
  const pins: PackageCliPin[] = [];
  try {
    if (realpathSync(workspace) !== workspace) throw new Error('Workspace must be canonical');
    let names: string[];
    try {
      names = readdirSync(join(workspace, 'node_modules', '.bin'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return pins;
      throw error;
    }
    if (names.length > 256) throw new Error('Too many package command entrypoints');
    const budget: ReadBudget = { bytes: 0 };
    const destinations = new Map<string, { bytes: Buffer; execute: boolean }>();
    let pathBytes = 0;
    let sourceBytes = 0;
    let bins: Map<string, string> | undefined;
    const admit = (file: string, bytes: Buffer, execute: boolean): void => {
      const previous = destinations.get(file);
      if (previous) {
        if (previous.execute !== execute || !previous.bytes.equals(bytes))
          throw new Error('Conflicting package mount destinations');
        return;
      }
      sourceBytes += bytes.length;
      if (sourceBytes > TOTAL_LIMIT) throw new Error('Package CLI snapshot byte limit exceeded');
      const pin = privatePin(file, bytes, execute);
      pins.push(pin);
      destinations.set(file, { bytes, execute });
      pathBytes += Buffer.byteLength(file) + Buffer.byteLength(realpathSync(`/proc/self/fd/${pin.descriptor}`));
      if (pathBytes > 64 * 1024) throw new Error('Package command entrypoint paths exceed the limit');
    };
    for (const name of names.sort()) {
      if (!CLI.test(name)) throw new Error('Unsafe package command entrypoint');
      const file = inside(workspace, join(workspace, 'node_modules', '.bin', name));
      const source = snapshot(file, budget);
      const line = source.bytes.subarray(0, 256).toString('utf8').split('\n')[0];
      if (line === '#!/usr/bin/env node') {
        admit(file, source.bytes, true);
        continue;
      }
      if (line !== '#!/bin/sh') continue;
      if (source.links !== 1) throw new Error('Shell entrypoint must be a private regular file');
      bins ??= mappings(workspace, budget);
      const target = bins.get(name);
      if (!target) throw new Error('Shell entrypoint has no unique Node mapping');
      const script = snapshot(target, budget);
      if (script.bytes.subarray(0, 256).toString('utf8').split('\n')[0] !== '#!/usr/bin/env node') continue;
      const wrapper = Buffer.from(
        '#!/usr/bin/env node\n' +
          `const r=require('node:child_process').spawnSync(process.execPath,[${JSON.stringify(target)},...process.argv.slice(2)],{stdio:'inherit',env:process.env});\n` +
          "if(r.error){process.stderr.write('Package CLI failed\\n');process.exit(1);}if(r.signal){process.kill(process.pid,r.signal);}process.exit(r.status===null?1:r.status);\n",
      );
      admit(file, wrapper, true);
      admit(target, script.bytes, false);
    }
    return pins;
  } catch (error) {
    const errors: unknown[] = [];
    for (const pin of pins) {
      try {
        closeSync(pin.descriptor);
      } catch (cause) {
        errors.push(cause);
      }
      try {
        pin.cleanup?.();
      } catch (cause) {
        errors.push(cause);
      }
    }
    if (errors.length)
      throw new AggregateError([error, ...errors], 'Package command admission and cleanup failed', { cause: error });
    throw error;
  }
}
