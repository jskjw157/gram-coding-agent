import { execFileSync, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  linkSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { pinPackageEntrypoints, type PackageCliPin } from './package-cli-pins.js';
let root: string;
let pins: PackageCliPin[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gram-package-pins-'));
  pins = [];
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
});
afterEach(() => {
  for (const pin of pins) {
    closeSync(pin.descriptor);
    pin.cleanup?.();
  }
  rmSync(root, { recursive: true, force: true });
});
function fixture(name = 'fixture', bin: unknown = { fixture: 'cli.js' }): string {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { [name]: '1.0.0' } }));
  const pkg = join(root, 'node_modules', name);
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name, bin }));
  writeFileSync(
    join(pkg, 'cli.js'),
    '#!/usr/bin/env node\nif(require.main!==module)process.exit(23);process.stdout.write("cli:"+process.argv.slice(2).join(","));\n',
    { mode: 0o755 },
  );
  const stub = join(root, 'node_modules', '.bin', 'fixture');
  writeFileSync(stub, '#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir/../fixture/cli.js" "$@"\n', {
    mode: 0o755,
  });
  return stub;
}
it('pins a Node-only replacement for a pnpm shell stub without modifying it', () => {
  const stub = fixture();
  const original = readFileSync(stub);
  expect(execFileSync('/bin/sh', [stub, 'before'], { encoding: 'utf8' })).toBe('cli:before');
  pins = pinPackageEntrypoints(root);
  expect(pins).toHaveLength(2);
  const pin = pins[0];
  expect(pin?.path).toBe(realpathSync(stub));
  expect(pin?.execute).toBe(true);
  if (!pin) throw new Error('missing pin');
  expect(readFileSync(`/proc/self/fd/${pin.descriptor}`, 'utf8')).toMatch(/^#!\/usr\/bin\/env node\n/);
  expect(
    execFileSync(process.execPath, [`/proc/self/fd/3`, 'after'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe', pin.descriptor],
    }),
  ).toBe('cli:after');
  expect(readFileSync(stub)).toEqual(original);
  const backing = realpathSync(`/proc/self/fd/${pin.descriptor}`);
  expect(fstatSync(pin.descriptor).nlink).toBe(1);
  for (const current of pins) {
    closeSync(current.descriptor);
    current.cleanup?.();
  }
  pins = [];
  expect(existsSync(backing)).toBe(false);
});
it('snapshots direct Node shebang entrypoints into private descriptors', () => {
  const stub = fixture();
  writeFileSync(stub, '#!/usr/bin/env node\nprocess.exit(0);');
  pins = pinPackageEntrypoints(root);
  expect(pins).toHaveLength(1);
  expect(pins[0]?.cleanup).toBeTypeOf('function');
});
it('does not grant execution to an ELF or unknown interpreter', () => {
  const stub = fixture();
  writeFileSync(stub, '\x7fELF');
  pins = pinPackageEntrypoints(root);
  expect(pins).toHaveLength(0);
});
it('rejects an outside-workspace bin symlink', () => {
  const outside = mkdtempSync(join(tmpdir(), 'gram-outside-'));
  try {
    writeFileSync(join(outside, 'entry'), '#!/usr/bin/env node\n');
    symlinkSync(join(outside, 'entry'), join(root, 'node_modules', '.bin', 'fixture'));
    expect(() => pinPackageEntrypoints(root)).toThrow();
  } finally {
    rmSync(outside, { recursive: true });
  }
});

it('ignores unregistered top-level packages when deriving mappings', () => {
  fixture();
  const other = join(root, 'node_modules', 'unregistered');
  mkdirSync(other);
  writeFileSync(join(other, 'package.json'), 'malformed');
  pins = pinPackageEntrypoints(root);
  expect(pins).toHaveLength(2);
});
it('rejects ambiguous direct-dependency mappings', () => {
  fixture();
  const other = join(root, 'node_modules', 'other');
  mkdirSync(other);
  writeFileSync(join(other, 'package.json'), JSON.stringify({ name: 'other', bin: { fixture: 'cli.js' } }));
  writeFileSync(join(other, 'cli.js'), '#!/usr/bin/env node\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { fixture: '1', other: '1' } }));
  expect(() => pinPackageEntrypoints(root)).toThrow(/Ambiguous/);
});
it('resolves scoped direct dependencies symlinked into pnpm storage', () => {
  fixture('@scope/fixture');
  const storage = join(root, 'node_modules', '.pnpm', 'fixture', 'node_modules', '@scope', 'fixture');
  mkdirSync(storage, { recursive: true });
  writeFileSync(join(storage, 'package.json'), JSON.stringify({ name: '@scope/fixture', bin: { fixture: 'cli.js' } }));
  writeFileSync(join(storage, 'cli.js'), '#!/usr/bin/env node\nprocess.stdout.write("scoped");');
  rmSync(join(root, 'node_modules', '@scope', 'fixture'), { recursive: true });
  symlinkSync(storage, join(root, 'node_modules', '@scope', 'fixture'));
  pins = pinPackageEntrypoints(root);
  expect(pins).toHaveLength(2);
  const pin = pins[0];
  if (!pin) throw new Error('missing');
  expect(
    execFileSync(process.execPath, ['/proc/self/fd/3'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe', pin.descriptor],
    }),
  ).toBe('scoped');
});
it('does not grant mapped native targets execution', () => {
  fixture();
  writeFileSync(join(root, 'node_modules', 'fixture', 'cli.js'), 'MZsynthetic-pe');
  pins = pinPackageEntrypoints(root);
  expect(pins).toHaveLength(0);
});
it('propagates Node CLI exit status', () => {
  fixture();
  writeFileSync(join(root, 'node_modules', 'fixture', 'cli.js'), '#!/usr/bin/env node\nprocess.exit(37);');
  pins = pinPackageEntrypoints(root);
  const pin = pins[0];
  if (!pin) throw new Error('missing');
  expect(
    spawnSync(process.execPath, ['/proc/self/fd/3'], { stdio: ['ignore', 'pipe', 'pipe', pin.descriptor] }).status,
  ).toBe(37);
});

it('rejects hardlinked original stubs', () => {
  const stub = fixture();
  linkSync(stub, join(root, 'second-link'));
  expect(() => pinPackageEntrypoints(root)).toThrow(/private regular/);
});
it('rejects an escaping mapped target', () => {
  fixture();
  writeFileSync(
    join(root, 'node_modules', 'fixture', 'package.json'),
    JSON.stringify({ bin: { fixture: '../../../outside' } }),
  );
  expect(() => pinPackageEntrypoints(root)).toThrow(/escapes/);
});
it('rejects malformed and oversized manifests', () => {
  fixture();
  writeFileSync(join(root, 'package.json'), 'not-json');
  expect(() => pinPackageEntrypoints(root)).toThrow();
  writeFileSync(join(root, 'package.json'), ' '.repeat(1024 * 1024 + 1));
  expect(() => pinPackageEntrypoints(root)).toThrow(/Unsafe/);
});
it('closes earlier pins and removes generated wrappers after a later admission failure', () => {
  fixture();
  const outside = mkdtempSync(join(tmpdir(), 'gram-outside-'));
  try {
    writeFileSync(join(outside, 'entry'), '#!/usr/bin/env node\n');
    symlinkSync(join(outside, 'entry'), join(root, 'node_modules', '.bin', 'zbad'));
    const before = readdirSync('/proc/self/fd').length;
    const dirs = readdirSync(tmpdir())
      .filter((name) => name.startsWith('gram-package-cli-'))
      .sort();
    expect(() => pinPackageEntrypoints(root)).toThrow();
    expect(readdirSync('/proc/self/fd').length).toBe(before);
    expect(
      readdirSync(tmpdir())
        .filter((name) => name.startsWith('gram-package-cli-'))
        .sort(),
    ).toEqual(dirs);
  } finally {
    rmSync(outside, { recursive: true });
  }
});
it('replacement target bytes remain Node input and never become shell execution', () => {
  fixture();
  pins = pinPackageEntrypoints(root);
  const marker = join(root, 'executed');
  writeFileSync(join(root, 'node_modules', 'fixture', 'cli.js'), '#!/bin/sh\ntouch ' + marker + '\n');
  const pin = pins[0];
  if (!pin) throw new Error('missing');
  const result = spawnSync(process.execPath, ['/proc/self/fd/3'], {
    stdio: ['ignore', 'pipe', 'pipe', pin.descriptor],
  });
  expect(result.status).not.toBe(0);
  expect(existsSync(marker)).toBe(false);
});
it('propagates the child signal', () => {
  fixture();
  writeFileSync(
    join(root, 'node_modules', 'fixture', 'cli.js'),
    '#!/usr/bin/env node\nprocess.kill(process.pid,"SIGTERM");',
  );
  pins = pinPackageEntrypoints(root);
  const pin = pins[0];
  if (!pin) throw new Error('missing');
  expect(
    spawnSync(process.execPath, ['/proc/self/fd/3'], { stdio: ['ignore', 'pipe', 'pipe', pin.descriptor] }).signal,
  ).toBe('SIGTERM');
});

it('snapshots a hardlinked direct Node entrypoint instead of granting its inode execution', () => {
  const stub = fixture();
  writeFileSync(stub, '#!/usr/bin/env node\nprocess.stdout.write("original");');
  linkSync(stub, join(root, 'shared-script'));
  pins = pinPackageEntrypoints(root);
  expect(pins).toHaveLength(1);
  const pin = pins[0];
  if (!pin) throw new Error('missing');
  expect(fstatSync(pin.descriptor).nlink).toBe(1);
  expect(fstatSync(pin.descriptor).ino).not.toBe(lstatSync(stub).ino);
  writeFileSync(stub, '#!/usr/bin/env node\nprocess.stdout.write("mutated");');
  expect(
    execFileSync(process.execPath, ['/proc/self/fd/3'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe', pin.descriptor],
    }),
  ).toBe('original');
});
it('snapshots hardlinked pnpm target and accepts hardlinked manifest as data only', () => {
  const stub = fixture();
  const target = join(root, 'node_modules', 'fixture', 'cli.js');
  const manifest = join(root, 'node_modules', 'fixture', 'package.json');
  linkSync(target, join(root, 'shared-target'));
  linkSync(manifest, join(root, 'shared-manifest'));
  pins = pinPackageEntrypoints(root);
  expect(pins).toHaveLength(2);
  const wrapper = pins.find((pin) => pin.path === stub);
  const data = pins.find((pin) => pin.path === target);
  expect(wrapper?.execute).toBe(true);
  expect(data?.execute).toBeUndefined();
  if (!data) throw new Error('missing target');
  expect(fstatSync(data.descriptor).nlink).toBe(1);
  expect(fstatSync(data.descriptor).ino).not.toBe(lstatSync(target).ino);
});

it('rejects per-file source and aggregate snapshot size overflow without leaking FDs', () => {
  const stub = fixture();
  writeFileSync(stub, '#!/usr/bin/env node\n' + ' '.repeat(1024 * 1024));
  expect(() => pinPackageEntrypoints(root)).toThrow(/Unsafe/);
  rmSync(stub);
  for (let index = 0; index < 17; index++)
    writeFileSync(
      join(root, 'node_modules', '.bin', 'cli' + String(index).padStart(2, '0')),
      '#!/usr/bin/env node\n' + ' '.repeat(1024 * 1024 - Buffer.byteLength('#!/usr/bin/env node\n')),
    );
  const before = readdirSync('/proc/self/fd').length;
  expect(() => pinPackageEntrypoints(root)).toThrow(/byte limit/);
  expect(readdirSync('/proc/self/fd').length).toBe(before);
});
it('rejects execution-role conflicts at one canonical destination', () => {
  fixture();
  symlinkSync(join(root, 'node_modules', 'fixture', 'cli.js'), join(root, 'node_modules', '.bin', 'direct'));
  expect(() => pinPackageEntrypoints(root)).toThrow(/Conflicting/);
});
it('deduplicates identical direct CLI snapshot destinations', () => {
  const stub = fixture();
  writeFileSync(stub, '#!/usr/bin/env node\nprocess.exit(0);');
  symlinkSync(stub, join(root, 'node_modules', '.bin', 'alias'));
  pins = pinPackageEntrypoints(root);
  expect(pins).toHaveLength(1);
  const pin = pins[0];
  if (!pin) throw new Error('missing');
  expect(fstatSync(pin.descriptor).mode & 0o777).toBe(0o700);
});
