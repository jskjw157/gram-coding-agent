#!/usr/bin/env python3
"""Trusted offline-profile installer: only pinned official artifacts, never user runtimes.

No task-facing options, alternative artifact URLs, or existing-tree repair mode.
Imported pure helpers support unprivileged fixture tests; main always requires root.
"""
import base64
import ctypes
import errno
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import sys
import tarfile
import tempfile
import urllib.request

NODE_VERSION = '24.21.0'
PNPM_VERSION = '10.34.5'
NODE_SHA256 = 'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6'
PNPM_SHA512 = 'pO4F8vc2WCVb1qiYWcBlpFwopX2u+uLIk6Fo7itzFow3uR6D5X6mdlStA/AwMXRkMOi84442LgQmBfuKvIAZLg=='
EXPECTED_TREE_SHA256 = '2e89512825a43334ef6e73a62bd71b777b029042eecbca361d9c7a62df6ebc61'
EXPECTED_FILE_COUNT = 3705
POLICY = 'linux-node-v1-runtime-1'
DESTINATION = Path('/opt/gram-sandbox-runtime/node-24-pnpm-10.34.5-verified')
CACHE = Path('/var/cache/gram-sandbox-artifacts')
ARTIFACTS = {
    'node': (f'https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-linux-x64.tar.xz', 'sha256', NODE_SHA256),
    'pnpm': (f'https://registry.npmjs.org/pnpm/-/pnpm-{PNPM_VERSION}.tgz', 'sha512', PNPM_SHA512),
}
LINKS = {'bin/npm': '../lib/node_modules/npm/bin/npm-cli.js',
         'bin/npx': '../lib/node_modules/npm/bin/npx-cli.js',
         'bin/pnpm': '../lib/node_modules/pnpm/bin/pnpm.cjs'}
MAX_ARCHIVE = 64 * 1024 * 1024
MAX_FILE = 160 * 1024 * 1024
MAX_TOTAL = 512 * 1024 * 1024
MAX_MEMBERS = 20000


def verify_bytes(data, algorithm, expected):
    digest = hashlib.new(algorithm, data).digest()
    actual = digest.hex() if algorithm == 'sha256' else base64.b64encode(digest).decode('ascii')
    if actual != expected:
        raise ValueError('Artifact digest mismatch')
    return data


def safe_path(name):
    if (not name or len(name) > 1024 or any(ord(c) < 33 or ord(c) > 126 or c in '\\"' for c in name)
            or any(part in ('', '.', '..') for part in name.split('/'))):
        raise ValueError('Unsafe archive path')
    return name


def curate(data, kind):
    """Parse verified bytes without extracting archive-controlled filesystem entries."""
    if len(data) > MAX_ARCHIVE:
        raise ValueError('Archive byte limit')
    prefix = f'node-v{NODE_VERSION}-linux-x64/' if kind == 'node' else 'package/'
    tree, seen, total = {}, set(), 0
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:*') as archive:
        for index, member in enumerate(archive):
            if index >= MAX_MEMBERS:
                raise ValueError('Archive member limit')
            name = safe_path(member.name.rstrip('/') if member.isdir() else member.name)
            if name in seen:
                raise ValueError('Duplicate archive member')
            seen.add(name)
            if not name.startswith(prefix) and name != prefix.rstrip('/'):
                raise ValueError('Unexpected archive root')
            relative = name[len(prefix):]
            if member.issym() and kind == 'node' and relative in {
                **LINKS, 'bin/corepack': '../lib/node_modules/corepack/dist/corepack.js'
            }:
                expected = {**LINKS, 'bin/corepack': '../lib/node_modules/corepack/dist/corepack.js'}[relative]
                if member.linkname != expected:
                    raise ValueError('Unexpected official link')
                continue  # Only our fixed links are materialized.
            if not member.isfile() and not member.isdir():
                raise ValueError('Archive links and special files forbidden')
            if member.size < 0 or member.size > MAX_FILE:
                raise ValueError('Archive member byte limit')
            total += member.size
            if total > MAX_TOTAL:
                raise ValueError('Archive expanded byte limit')
            selected = kind == 'pnpm' or relative == 'bin/node' or relative.startswith('lib/node_modules/npm/')
            if kind == 'pnpm' and relative in {
                'dist/vendor/fastlist-0.3.0-x64.exe', 'dist/vendor/fastlist-0.3.0-x86.exe',
                'dist/reflink.win32-arm64-msvc-Q6BARPPB.node', 'dist/reflink.win32-x64-msvc-J2TZHRQI.node',
            }:
                continue  # Fixed Windows-only artifact exclusions; never mounted or executable.
            if not selected or not member.isfile():
                continue
            target = 'lib/node_modules/pnpm/' + relative if kind == 'pnpm' else relative
            safe_path(target)
            with archive.extractfile(member) as stream:
                content = stream.read(member.size + 1)
            if len(content) != member.size:
                raise ValueError('Archive member size mismatch')
            if target != 'bin/node' and (content.startswith(b'\x7fELF') or content.startswith(b'MZ')):
                raise ValueError('Unexpected native executable')
            executable = target == 'bin/node' or content.startswith(b'#!/usr/bin/env node\n') or content.startswith(b'#!/usr/bin/env node\r\n')
            tree[target] = ('f', 0o755 if executable else 0o644, content)
    return tree


def assemble(node, pnpm):
    tree = {**curate(verify_bytes(node, 'sha256', NODE_SHA256), 'node'),
            **curate(verify_bytes(pnpm, 'sha512', PNPM_SHA512), 'pnpm')}
    if not tree.get('bin/node', ('', 0, b''))[2].startswith(b'\x7fELF'):
        raise ValueError('Verified Node executable missing')
    for package, version in [('npm', None), ('pnpm', PNPM_VERSION)]:
        manifest = json.loads(tree[f'lib/node_modules/{package}/package.json'][2])
        if manifest.get('name') != package or (version and manifest.get('version') != version):
            raise ValueError('Package identity mismatch')
    for name, target in LINKS.items():
        if str(PurePosixPath('lib/node_modules') / target.split('lib/node_modules/', 1)[1]) not in tree:
            raise ValueError('CLI target missing')
        tree[name] = ('l', 0o777, target)
    for name in list(tree):
        for parent in PurePosixPath(name).parents:
            if str(parent) != '.':
                if str(parent) in tree and tree[str(parent)][0] != 'd':
                    raise ValueError('Tree path conflict')
                tree[str(parent)] = ('d', 0o755, '')
    return tree


def manifest(tree):
    return [[name, {'d': 'directory', 'f': 'file', 'l': 'symlink'}[kind], mode, len(value) if kind in ('f', 'l') else 0,
             hashlib.sha256(value).hexdigest() if kind == 'f' else value]
            for name, (kind, mode, value) in sorted(tree.items())]


def tree_digest(tree):
    return hashlib.sha256(json.dumps(manifest(tree), ensure_ascii=True, separators=(',', ':')).encode('ascii')).hexdigest()


def receipt(tree):
    return {'schemaVersion': 1, 'policyVersion': POLICY, 'nodeVersion': NODE_VERSION,
            'nodeArchiveSha256': NODE_SHA256, 'pnpmVersion': PNPM_VERSION,
            'pnpmTarballSha512': PNPM_SHA512, 'fileCount': len(tree), 'treeSha256': tree_digest(tree)}


def trusted_directory(directory):
    for current in [directory, *directory.parents]:
        metadata = current.lstat()
        if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o022:
            raise ValueError('Root-owned non-writable directory ancestors required')


def read_artifact(file, algorithm, digest):
    descriptor = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(descriptor)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != 0 or before.st_nlink != 1
                or before.st_mode & 0o077 or before.st_size > MAX_ARCHIVE):
            raise ValueError('Untrusted artifact inode')
        with os.fdopen(os.dup(descriptor), 'rb') as stream:
            data = stream.read(MAX_ARCHIVE + 1)
        after = os.fstat(descriptor)
        fields = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
        if any(getattr(before, key) != getattr(after, key) for key in fields) or len(data) != before.st_size:
            raise ValueError('Artifact changed during read')
        return verify_bytes(data, algorithm, digest)
    finally:
        os.close(descriptor)


def artifact(kind):
    url, algorithm, digest = ARTIFACTS[kind]
    file = CACHE / (kind + '-' + hashlib.sha256(digest.encode()).hexdigest() + '.archive')
    if not file.exists():
        # No redirects: official fixed HTTPS endpoints only.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                raise ValueError('Artifact redirect forbidden')
        with urllib.request.build_opener(NoRedirect).open(url, timeout=60) as response:
            data = response.read(MAX_ARCHIVE + 1)
        if len(data) > MAX_ARCHIVE:
            raise ValueError('Downloaded artifact too large')
        verify_bytes(data, algorithm, digest)
        descriptor = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    return read_artifact(file, algorithm, digest)


def materialize(tree, destination):
    for name, (kind, mode, value) in sorted(tree.items()):
        target = destination / name
        if kind == 'd':
            target.mkdir(mode=mode)
            target.chmod(mode)
        elif kind == 'l':
            target.symlink_to(value)
        else:
            descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
            with os.fdopen(descriptor, 'wb') as stream:
                stream.write(value)
            target.chmod(mode)


def scan(destination):
    tree = {}
    for root, directories, files in os.walk(destination, followlinks=False):
        for name in directories + files:
            file = Path(root) / name
            relative = file.relative_to(destination).as_posix()
            if relative == 'installation.json':
                continue
            safe_path(relative)
            metadata = file.lstat()
            if metadata.st_uid != os.geteuid():
                raise ValueError('Unexpected staged owner')
            mode = stat.S_IMODE(metadata.st_mode)
            if stat.S_ISLNK(metadata.st_mode):
                target = os.readlink(file)
                if LINKS.get(relative) != target or not file.resolve().is_relative_to(destination.resolve()):
                    raise ValueError('Unexpected staged link')
                tree[relative] = ('l', mode, target)
            elif stat.S_ISDIR(metadata.st_mode):
                tree[relative] = ('d', mode, '')
            elif stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1:
                tree[relative] = ('f', mode, file.read_bytes())
            else:
                raise ValueError('Unexpected staged inode')
    return tree


def publish(source, destination):
    # Linux renameat2(RENAME_NOREPLACE) gives an atomic no-clobber boundary.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.renameat2(-100, os.fsencode(source), -100, os.fsencode(destination), 1) != 0:
        code = ctypes.get_errno()
        if code == errno.EEXIST:
            raise FileExistsError(destination)
        raise OSError(code, os.strerror(code))


def main():
    if os.geteuid() != 0 or len(sys.argv) != 1:
        raise SystemExit('Requires trusted root installer without arguments')
    if DESTINATION.exists() or DESTINATION.is_symlink():
        raise SystemExit('Destination exists; no overwrite permitted')
    for directory in [CACHE, DESTINATION.parent]:
        trusted_directory(directory.parent)
        directory.mkdir(mode=0o700 if directory == CACHE else 0o755, exist_ok=True)
        trusted_directory(directory)
    if stat.S_IMODE(CACHE.stat().st_mode) != 0o700:
        raise ValueError('Artifact cache must be private')
    tree = assemble(artifact('node'), artifact('pnpm'))
    if len(tree) != EXPECTED_FILE_COUNT or tree_digest(tree) != EXPECTED_TREE_SHA256:
        raise ValueError('Pinned runtime tree mismatch')
    temporary = Path(tempfile.mkdtemp(prefix='.stage-', dir=DESTINATION.parent))
    try:
        materialize(tree, temporary)
        if manifest(scan(temporary)) != manifest(tree):
            raise ValueError('Materialized runtime mismatch')
        metadata = receipt(tree)
        with (temporary / 'installation.json').open('x') as stream:
            json.dump(metadata, stream, separators=(',', ':'))
            stream.write('\n')
        (temporary / 'installation.json').chmod(0o644)
        temporary.chmod(0o755)
        publish(temporary, DESTINATION)
        print(json.dumps(metadata))
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)  # Only our new private staging directory.


if __name__ == '__main__':
    main()
