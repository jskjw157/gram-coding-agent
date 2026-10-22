import * as fs from 'node:fs';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

const ROOT = process.argv[2];
const VAULT = process.argv[3];
const RECOVERY = '/run/gram-owner-fs/home/recovery';
const WORKER = '/usr/local/libexec/gram-owner-fs-worker.mjs';
const NATIVE = '/usr/local/libexec/gram-owner-fs-native';
const FILE_LIMIT = 1024 * 1024;
const INPUT_LIMIT = 3 * 1024 * 1024;
const OUTPUT_LIMIT = 4 * 1024 * 1024;
const C = fs.constants;
const DIRECTORY = C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW | C.O_CLOEXEC;
const FILE = C.O_NOFOLLOW | C.O_NONBLOCK | C.O_CLOEXEC;
const RESERVED = /^\.gram-owner-fs-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const descriptors = new Set();
let unresolved = false;

function deny() { throw new Error('denied'); }
function requireValue(value) { if (!value) deny(); }
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function identity(st) { return `${st.dev}:${st.ino}`; }
function identityText(value) {
  return typeof value === 'string' && /^\d{1,20}:\d{1,20}$/u.test(value);
}
function component(value, internal = false) {
  return typeof value === 'string' && value.length > 0 &&
    Buffer.byteLength(value) <= 255 && Buffer.from(value).toString('utf8') === value &&
    value !== '.' && value !== '..' && !/[\\/:<>"|?*]/u.test(value) &&
    !Array.from(value).some(char => char.charCodeAt(0) < 32 || (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159)) &&
    !/[. ]$/u.test(value) &&
    !/^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(value) &&
    (internal || !RESERVED.test(value));
}
function textPath(value, allowRoot = false) {
  if (allowRoot && value === '.') return true;
  return typeof value === 'string' && Buffer.byteLength(value) <= 2048 &&
    value.split('/').length <= 60 && value.split('/').every(part => component(part));
}
function payload(value) {
  requireValue(typeof value === 'string' && value.length <= Math.ceil(FILE_LIMIT / 3) * 4);
  const bytes = Buffer.from(value, 'base64');
  requireValue(bytes.length <= FILE_LIMIT && bytes.toString('base64') === value);
  return bytes;
}
function paths(value) {
  requireValue(Array.isArray(value) && value.length <= 256 &&
    value.every(path => textPath(path, true)));
}
function validate(request) {
  requireValue(object(request) && request.root === ROOT);
  const operation = request.operation;
  requireValue(['list', 'stat', 'read', 'treeStat', 'write', 'move', 'mkdir', 'trash', 'restore'].includes(operation));
  requireValue(textPath(request.path, operation === 'list' || operation === 'stat'));
  const keys = ['operation', 'root', 'path', 'protectedPaths'];
  paths(request.protectedPaths);
  if (Object.hasOwn(request, 'protectedMutationPaths')) {
    keys.push('protectedMutationPaths');
    paths(request.protectedMutationPaths);
  }
  if (['write', 'move', 'mkdir', 'trash', 'restore'].includes(operation)) {
    keys.push('expectedRootIdentity');
    requireValue(identityText(request.expectedRootIdentity));
  }
  if (operation === 'write') {
    keys.push('expectedFileIdentity', 'expectedBase64', 'base64', 'recoveryRoot', 'expectedRecoveryRootIdentity');
    requireValue(request.recoveryRoot === VAULT && identityText(request.expectedRecoveryRootIdentity));
    payload(request.base64);
    if (request.expectedBase64 === null) {
      requireValue(request.expectedFileIdentity === null);
    } else {
      payload(request.expectedBase64);
      requireValue(identityText(request.expectedFileIdentity));
    }
  }
  if (['move', 'trash', 'restore'].includes(operation)) {
    keys.push('expectedFileIdentity');
    requireValue(identityText(request.expectedFileIdentity));
    if (operation === 'move') {
      keys.push('destination');
      requireValue(textPath(request.destination) && request.destination !== request.path);
    } else {
      keys.push('recoveryRoot', 'recoveryId', 'expectedRecoveryRootIdentity');
      requireValue(request.recoveryRoot === VAULT && component(request.recoveryId) && identityText(request.expectedRecoveryRootIdentity));
    }
    if (request.expectedKind === 'directory') {
      keys.push('expectedKind', 'expectedVersion');
      requireValue(typeof request.expectedVersion === 'string' && /^[a-f0-9]{64}$/u.test(request.expectedVersion));
    } else {
      keys.push('expectedBase64');
      if (operation !== 'move' || Object.hasOwn(request, 'expectedKind')) {
        keys.push('expectedKind');
        requireValue(request.expectedKind === 'file');
      }
      payload(request.expectedBase64);
    }
  }
  requireValue(Object.keys(request).length === keys.length &&
    Object.keys(request).every(key => keys.includes(key)));
  return request;
}
function blocked(path, protectedPaths, ancestors = false) {
  return protectedPaths.some(protectedPath =>
    protectedPath === '.' || path === protectedPath ||
    path.startsWith(`${protectedPath}/`) ||
    (ancestors && (path === '.' || protectedPath.startsWith(`${path}/`))));
}
function protect(request, path, mutation = false) {
  requireValue(!blocked(path, request.protectedPaths, mutation));
  if (mutation) requireValue(!blocked(path, request.protectedMutationPaths ?? [], true));
}
function pin(path, flags, mode) {
  const fd = fs.openSync(path, flags, mode);
  descriptors.add(fd);
  return fd;
}
function release(fd) {
  if (descriptors.delete(fd)) fs.closeSync(fd);
}
function proc(fd, leaf) {
  return `/proc/self/fd/${fd}${leaf === undefined ? '' : `/${leaf}`}`;
}
function ext4(fd) {
  requireValue(fs.statfsSync(proc(fd), { bigint: true }).type === 0xef53n);
}
function confined(fd, vault = false) {
  const root = vault ? VAULT : ROOT;
  const resolved = fs.realpathSync(proc(fd));
  requireValue(resolved === root || resolved.startsWith(`${root}/`));
}
function directory(fd, vault = false) {
  requireValue(fs.fstatSync(fd, { bigint: true }).isDirectory());
  confined(fd, vault);
}
function parent(root, path) {
  const parts = path.split('/');
  const leaf = parts.pop();
  let fd = root;
  for (const part of parts) {
    directory(fd);
    fd = pin(proc(fd, part), DIRECTORY);
    directory(fd);
  }
  return { fd, leaf };
}
function openDirectory(root, path) {
  if (path === '.') return root;
  const location = parent(root, path);
  directory(location.fd);
  const fd = pin(proc(location.fd, location.leaf), DIRECTORY);
  directory(fd);
  return fd;
}
function regular(st) {
  requireValue(st.isFile() && st.nlink === 1n && !(st.mode & 0o6000n));
}
function sameStat(a, b) {
  return ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs']
    .every(key => a[key] === b[key]);
}
function native(command, args, fds) {
  requireValue(['metadata', 'copy-permissions', 'exchange', 'noreplace'].includes(command));
  const result = spawnSync(NATIVE, [command, ...args], {
    stdio: ['ignore', 'pipe', 'ignore', ...fds],
    env: { LANG: 'C' },
    timeout: 10000,
    killSignal: 'SIGKILL',
    maxBuffer: 512 * 1024,
    windowsHide: true,
  });
  requireValue(!result.error && result.status === 0 && result.signal === null);
  return result.stdout;
}
function metadata(fd) {
  const output = native('metadata', [], [fd]).toString('ascii');
  requireValue(output.length <= 350000 && /^[A-Za-z0-9+/]+={0,2}\n$/u.test(output));
  const encoded = output.slice(0, -1);
  requireValue(Buffer.from(encoded, 'base64').toString('base64') === encoded);
  return encoded;
}
function rename(command, from, to) {
  directory(from.fd, from.vault);
  directory(to.fd, to.vault);
  // Once a mutating helper starts, loss of its acknowledgement is unresolved.
  unresolved = true;
  requireValue(native(command, [from.leaf, to.leaf], [from.fd, to.fd]).equals(Buffer.from('OK\n')));
}
function snapshot(fd) {
  const before = fs.fstatSync(fd, { bigint: true });
  regular(before);
  requireValue(before.size >= 0n && before.size <= BigInt(FILE_LIMIT));
  const meta = metadata(fd);
  const bytes = Buffer.alloc(Number(before.size) + 1);
  let used = 0;
  while (used < bytes.length) {
    const count = fs.readSync(fd, bytes, used, bytes.length - used, used);
    if (count === 0) break;
    used += count;
  }
  const after = fs.fstatSync(fd, { bigint: true });
  requireValue(sameStat(before, after) && BigInt(used) === before.size);
  return { identity: identity(before), base64: bytes.subarray(0, used).toString('base64'),
    bytes: used, metadata: meta };
}
function expected(actual, request) {
  requireValue(actual.identity === request.expectedFileIdentity &&
    actual.base64 === request.expectedBase64);
}
function equalSnapshot(a, b) {
  return a.identity === b.identity && a.base64 === b.base64 && a.metadata === b.metadata;
}
function openFile(location) {
  directory(location.fd, location.vault);
  const fd = pin(proc(location.fd, location.leaf), FILE | C.O_RDONLY);
  regular(fs.fstatSync(fd, { bigint: true }));
  confined(fd, location.vault);
  return fd;
}
function rootStill(root, rootIdentity) {
  directory(root);
  requireValue(fs.realpathSync(ROOT) === ROOT);
  const current = fs.lstatSync(ROOT, { bigint: true });
  requireValue(current.isDirectory() && identity(current) === rootIdentity &&
    identity(fs.fstatSync(root, { bigint: true })) === rootIdentity);
}
function recovery() {
  requireValue(fs.realpathSync(RECOVERY) === RECOVERY);
  const fd = pin(RECOVERY, DIRECTORY);
  const st = fs.fstatSync(fd, { bigint: true });
  requireValue(st.isDirectory() && st.uid === BigInt(process.geteuid()) &&
    (st.mode & 0o7777n) === 0o700n && fs.readdirSync(proc(fd)).length === 0);
  ext4(fd);
  return fd;
}
function vaultRoot(root, request) {
  requireValue(fs.realpathSync(VAULT) === VAULT);
  const fd = pin(VAULT, DIRECTORY);
  const st = fs.fstatSync(fd, { bigint: true });
  requireValue(st.isDirectory() && st.uid === BigInt(process.geteuid()) &&
    (st.mode & 0o7777n) === 0o700n && identity(st) === request.expectedRecoveryRootIdentity &&
    st.dev === fs.fstatSync(root, { bigint: true }).dev);
  ext4(fd);
  return fd;
}
function treeSnapshot(fd, request, path, vault = false) {
  const hash = createHash('sha256');
  let count = 0, bytes = 0;
  function visit(current, relative, depth) {
    requireValue(depth <= 60 && ++count <= 10000);
    directory(current, vault);
    const before = fs.fstatSync(current, { bigint: true });
    const permissions = metadata(current);
    hash.update(JSON.stringify([relative, 'directory', identity(before), permissions]));
    const names = fs.readdirSync(proc(current)).sort();
    for (const name of names) {
      requireValue(component(name, true) && ++count <= 10000);
      const child = relative === '.' ? name : `${relative}/${name}`;
      if (!vault) protect(request, `${path}/${child}`);
      directory(current, vault);
      const entry = pin(proc(current, name), FILE | C.O_RDONLY);
      confined(entry, vault);
      const st = fs.fstatSync(entry, { bigint: true });
      if (st.isDirectory()) visit(entry, child, depth + 1);
      else {
        const actual = snapshot(entry);
        bytes += actual.bytes;
        requireValue(bytes <= 16 * FILE_LIMIT);
        hash.update(JSON.stringify([child, 'file', actual.identity, actual.metadata, actual.base64]));
      }
      release(entry);
    }
    requireValue(sameStat(before, fs.fstatSync(current, { bigint: true })) && permissions === metadata(current));
  }
  visit(fd, '.', 0);
  return { identity: identity(fs.fstatSync(fd, { bigint: true })), version: hash.digest('hex') };
}
function mutationSnapshot(location, request) {
  if (request.expectedKind !== 'directory') return snapshot(openFile(location));
  directory(location.fd, location.vault);
  const fd = pin(proc(location.fd, location.leaf), DIRECTORY);
  directory(fd, location.vault);
  return treeSnapshot(fd, request, request.path, location.vault);
}
function expectedMutation(actual, request) {
  if (request.expectedKind !== 'directory') expected(actual, request);
  else requireValue(actual.identity === request.expectedFileIdentity && actual.version === request.expectedVersion);
}
function sameMutation(before, after, request) {
  return request.expectedKind === 'directory' ? before.identity === after.identity && before.version === after.version : equalSnapshot(before, after);
}
function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
    requireValue(count > 0);
    offset += count;
  }
  fs.fsyncSync(fd);
}
function temporary(location, bytes) {
  directory(location.fd);
  const leaf = `.gram-owner-fs-${randomUUID()}`;
  const fd = pin(proc(location.fd, leaf), FILE | C.O_RDWR | C.O_CREAT | C.O_EXCL, 0o600);
  unresolved = true;
  // Never unlink a pathname after a racy identity check. Failed unpublished
  // writes retain their reserved evidence and return OUTCOME_UNKNOWN.
  writeAll(fd, bytes);
  return { fd: location.fd, leaf, file: fd };
}
function statReply(fd) {
  const before = fs.fstatSync(fd, { bigint: true });
  requireValue(before.isDirectory() || before.isFile());
  if (before.isFile()) regular(before);
  const after = fs.fstatSync(fd, { bigint: true });
  requireValue(sameStat(before, after) && before.size >= 0n &&
    before.size <= BigInt(Number.MAX_SAFE_INTEGER));
  return { kind: before.isDirectory() ? 'directory' : 'file',
    identity: identity(before), bytes: Number(before.size) };
}
function list(request, root) {
  const fd = openDirectory(root, request.path);
  const before = fs.fstatSync(fd, { bigint: true });
  const iterator = fs.opendirSync(proc(fd));
  const entries = [];
  let omitted = false;
  let count = 0;
  try {
    for (let entry; (entry = iterator.readSync()) !== null;) {
      requireValue(++count <= 10000);
      if (RESERVED.test(entry.name)) { omitted = true; continue; }
      requireValue(component(entry.name));
      const path = request.path === '.' ? entry.name : `${request.path}/${entry.name}`;
      if (blocked(path, request.protectedPaths)) { omitted = true; continue; }
      directory(fd);
      const st = fs.lstatSync(proc(fd, entry.name), { bigint: true });
      let type;
      if (st.isSymbolicLink()) type = 'symlink';
      else if (st.isDirectory()) type = 'directory';
      else { regular(st); type = 'file'; }
      entries.push({ name: entry.name, type });
    }
  } finally {
    iterator.closeSync();
  }
  requireValue(sameStat(before, fs.fstatSync(fd, { bigint: true })));
  return { entries, omitted };
}
function execute(request) {
  requireValue(process.platform === 'linux' && process.argv.length === 4 &&
    process.argv[1] === WORKER && process.execArgv.length === 0 &&
    process.getuid() !== 0 && process.getuid() === process.geteuid() &&
    process.getgid() === process.getegid());
  process.umask(0o077);
  requireValue(fs.realpathSync(ROOT) === ROOT);
  const root = pin(ROOT, DIRECTORY);
  ext4(root);
  const rootIdentity = identity(fs.fstatSync(root, { bigint: true }));
  rootStill(root, rootIdentity);
  const mutation = ['write', 'move', 'mkdir', 'trash', 'restore'].includes(request.operation);
  protect(request, request.path, mutation);
  if (mutation) requireValue(request.expectedRootIdentity === rootIdentity);
  let result = {};
  if (request.operation === 'list') {
    result = list(request, root);
  } else if (request.operation === 'treeStat') {
    const actual = treeSnapshot(openDirectory(root, request.path), request, request.path);
    result = { kind: 'directory', ...actual };
  } else if (request.operation === 'stat') {
    if (request.path === '.') result = statReply(root);
    else {
      const location = parent(root, request.path);
      directory(location.fd);
      const fd = pin(proc(location.fd, location.leaf), FILE | C.O_RDONLY);
      confined(fd);
      result = statReply(fd);
    }
  } else if (request.operation === 'read') {
    const actual = snapshot(openFile(parent(root, request.path)));
    result = { kind: 'file', identity: actual.identity, bytes: actual.bytes, base64: actual.base64 };
  } else if (request.operation === 'mkdir') {
    const location = parent(root, request.path);
    rootStill(root, rootIdentity);
    directory(location.fd);
    unresolved = true;
    fs.mkdirSync(proc(location.fd, location.leaf), { mode: 0o700 });
    const created = pin(proc(location.fd, location.leaf), DIRECTORY);
    directory(created);
    fs.fsyncSync(created);
    fs.fsyncSync(location.fd);
  } else if (['move', 'trash', 'restore'].includes(request.operation)) {
    let source = parent(root, request.path), destination, vault;
    if (request.operation === 'move') {
      protect(request, request.destination, true);
      destination = parent(root, request.destination);
    } else {
      vault = vaultRoot(root, request);
      const captured = { fd: vault, leaf: request.recoveryId, vault: true };
      if (request.operation === 'restore') { destination = source; source = captured; }
      else destination = captured;
    }
    const before = mutationSnapshot(source, request);
    expectedMutation(before, request);
    rootStill(root, rootIdentity);
    rename('noreplace', source, destination);
    const after = mutationSnapshot(destination, request);
    requireValue(sameMutation(before, after, request));
    if (vault !== undefined) requireValue(identity(fs.lstatSync(VAULT, { bigint: true })) === request.expectedRecoveryRootIdentity);
    fs.fsyncSync(source.fd);
    fs.fsyncSync(destination.fd);
  } else {
    const destination = parent(root, request.path);
    let previous, source, recoveryFd, vaultFd;
    if (request.expectedBase64 !== null) {
      source = openFile(destination);
      previous = snapshot(source);
      expected(previous, request);
      recoveryFd = recovery();
      vaultFd = vaultRoot(root, request);
    }
    const bytes = payload(request.base64);
    const temp = temporary(destination, bytes);
    if (previous) {
      const copied = native('copy-permissions', [], [source, temp.file]).toString('ascii');
      requireValue(copied === `${previous.metadata}\n`);
      fs.fsyncSync(temp.file);
      requireValue(equalSnapshot(previous, snapshot(source)));
    }
    const prepared = snapshot(temp.file);
    requireValue(prepared.base64 === request.base64 &&
      (!previous || prepared.metadata === previous.metadata));
    rootStill(root, rootIdentity);
    if (previous) {
      rename('exchange', temp, destination);
      // Capture the actual displaced entry before moving that exact inode to
      // the original-path private vault. Never unlink a racy business pathname.
      const capturedFd = pin(proc(temp.fd, temp.leaf), FILE | C.O_RDONLY);
      const captured = snapshot(capturedFd);
      requireValue(equalSnapshot(previous, captured));
      const backupFd = pin(proc(recoveryFd, 'preimage'),
        FILE | C.O_RDWR | C.O_CREAT | C.O_EXCL, 0o600);
      writeAll(backupFd, Buffer.from(captured.base64, 'base64'));
      const copied = native('copy-permissions', [], [capturedFd, backupFd]).toString('ascii');
      requireValue(copied === `${captured.metadata}\n`);
      const backup = snapshot(backupFd);
      requireValue(backup.base64 === captured.base64 && backup.metadata === captured.metadata &&
        equalSnapshot(captured, snapshot(capturedFd)));
      const entry = `preimage-${randomUUID()}`;
      const mapping = { version: 1, rootIdentity, originalPath: request.path,
        identity: captured.identity, vaultIdentity: request.expectedRecoveryRootIdentity, entry };
      const mappingFd = pin(proc(recoveryFd, 'mapping.json'), FILE | C.O_RDWR | C.O_CREAT | C.O_EXCL, 0o600);
      writeAll(mappingFd, Buffer.from(JSON.stringify(mapping)));
      fs.fsyncSync(recoveryFd);
      const archived = { fd: vaultFd, leaf: entry, vault: true };
      rename('noreplace', temp, archived);
      requireValue(equalSnapshot(captured, snapshot(openFile(archived))) &&
        identity(fs.lstatSync(VAULT, { bigint: true })) === request.expectedRecoveryRootIdentity);
      fs.fsyncSync(vaultFd);
    } else {
      rename('noreplace', temp, destination);
    }
    requireValue(equalSnapshot(prepared, snapshot(openFile(destination))));
    fs.fsyncSync(destination.fd);
  }
  rootStill(root, rootIdentity);
  // This is capture-and-validate, not universal Linux compare-and-swap:
  // external writers can retain open FDs and write after these checks.
  // Landlock constrains later path operations on ancestors moved outside the
  // root; already-open file descriptors retain the kernel's usual limitation.
  return { ok: true, rootIdentity, ...result };
}

let response;
try {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    requireValue(length <= INPUT_LIMIT);
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks);
  const text = input.toString('utf8');
  requireValue(Buffer.from(text).equals(input));
  response = execute(validate(JSON.parse(text)));
} catch {
  response = { ok: false, code: unresolved ? 'OUTCOME_UNKNOWN' : 'NO_CHANGE' };
} finally {
  for (const fd of [...descriptors]) {
    try { release(fd); } catch { unresolved = true; }
  }
}
if (unresolved && response.ok !== true) response = { ok: false, code: 'OUTCOME_UNKNOWN' };
let output = Buffer.from(`${JSON.stringify(response)}\n`);
if (output.length > OUTPUT_LIMIT) {
  output = Buffer.from(JSON.stringify({ ok: false, code: unresolved ? 'OUTCOME_UNKNOWN' : 'NO_CHANGE' }) + '\n');
}
try {
  let offset = 0;
  while (offset < output.length) {
    const count = fs.writeSync(1, output, offset, output.length - offset);
    if (count <= 0) break;
    offset += count;
  }
} catch {
  process.exitCode = 1;
}
