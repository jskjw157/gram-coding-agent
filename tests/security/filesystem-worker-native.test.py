"""Real ext4/bubblewrap/Landlock tests; run in Linux as an unprivileged owner.

Usage: python3 tests/security/filesystem-worker-native.test.py [runtime-directory]
No production helper installation or service changes are made.
"""
import base64
import hashlib
import json
import os
import pathlib
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import unittest

SOURCE = pathlib.Path(__file__).resolve().parents[2]
# Exact git blob from main 85c7c6c6f7ff00868160ef195180b98405159b8c,
# apps/execution-sandbox/entry.c. Normalize checkout CRLF before integrity checks.
HISTORICAL_M5_SHA256 = '767bb1f03628f3393d0d3d65701937a320c37f157dc6f0222659039603169323'
RUNTIME = pathlib.Path(sys.argv.pop(1) if len(sys.argv) > 1 else
    '/var/lib/gram-sandbox-runtime/node-24-pnpm-10.34.5-verified')
ENC = lambda value: base64.b64encode(value).decode('ascii')


class FilesystemWorker(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if sys.platform != 'linux' or os.getuid() == 0:
            raise RuntimeError('requires unprivileged Linux and actual ext4 fixtures')
        cls.build = tempfile.TemporaryDirectory(prefix='gram-fs-build-', dir=pathlib.Path.home())
        cls.bin = pathlib.Path(cls.build.name)
        subprocess.run(['sh', str(SOURCE / 'apps/filesystem-worker/build.sh'), str(cls.bin)], check=True)
        shutil.copyfile(SOURCE / 'apps/filesystem-worker/worker.mjs', cls.bin / 'gram-owner-fs-worker.mjs')
        subprocess.run(['cc', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
                        str(SOURCE / 'apps/execution-sandbox/entry.c'), '-o', str(cls.bin / 'ordinary')], check=True)
        baseline = (SOURCE / 'tests/security/fixtures/m5-entry-85c7c6c.c').read_bytes().replace(b'\r\n', b'\n')
        if hashlib.sha256(baseline).hexdigest() != HISTORICAL_M5_SHA256:
            raise RuntimeError('historical M5 entry source integrity mismatch')
        baseline_directory = cls.bin / 'historical'
        baseline_directory.mkdir()
        # The same basename also avoids compiler STT_FILE metadata differences.
        baseline_source = baseline_directory / 'entry.c'
        baseline_source.write_bytes(baseline)
        subprocess.run(['cc', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
                        str(baseline_source), '-o', str(cls.bin / 'ordinary-historical')], check=True)
        probe = cls.bin / 'probe.c'
        probe.write_text('#include <errno.h>\n#include <fcntl.h>\n#include <sys/socket.h>\n#include <sys/xattr.h>\n#include <unistd.h>\n'
                         'int main(void){errno=0; if(socket(AF_INET,SOCK_STREAM,0)!=-1||errno!=EPERM)return 1; '
                         'int fd=open("probe",O_CREAT|O_RDWR,0600);if(fd<0)return 2; '
                         'errno=0;if(fsetxattr(fd,"user.probe","x",1,0)!=-1||errno!=EPERM)return 3; '
                         'errno=0;if(fgetxattr(fd,"user.probe",0,0)!=-1||errno!=EPERM)return 4; '
                         'errno=0;if(flistxattr(fd,0,0)!=-1||errno!=EPERM)return 5; '
                         'errno=0;if(fremovexattr(fd,"user.probe")!=-1||errno!=EPERM)return 6;close(fd);return 0;}\n')
        subprocess.run(['cc', '-O2', '-Wall', '-Wextra', '-Werror', str(probe), '-o', str(cls.bin / 'probe')], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.build.cleanup()

    def setUp(self):
        self.fixture = tempfile.TemporaryDirectory(prefix='gram-fs-native-', dir=pathlib.Path.home())
        self.base = pathlib.Path(self.fixture.name)
        self.root = self.base / 'root'
        self.root.mkdir()
        self.home = self.base / 'home'
        self.home.mkdir()
        self.recovery = self.home / 'recovery'
        self.recovery.mkdir(mode=0o700)
        self.outside = self.base / 'outside'
        self.outside.mkdir()
        self.vault = self.base / 'vault'
        self.vault.mkdir(mode=0o700)

    def tearDown(self):
        self.fixture.cleanup()

    def sandbox(self, ordinary=False):
        command = ['bwrap', '--unshare-all', '--die-with-parent', '--new-session',
                   '--bind', '/', '/', '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib',
                   '--ro-bind', '/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev',
                   '--tmpfs', '/run', '--dir', '/run/gram-owner-fs',
                   '--bind', str(self.home), '/run/gram-owner-fs/home',
                   '--ro-bind', str(RUNTIME), '/run/gram-owner-fs/runtime',
                   '--ro-bind', str(self.bin), '/usr/local/libexec', '--clearenv',
                   '--setenv', 'OPENSSL_CONF', '/dev/null',
                   '--setenv', 'HOME', '/run/gram-owner-fs/home', '--setenv', 'LANG', 'C', '--chdir', str(self.root)]
        if ordinary:
            return command + ['/usr/local/libexec/ordinary', str(self.root), '/run/gram-owner-fs/runtime', '--', str(pathlib.Path('/usr/bin/true').resolve())]
        return command + ['/usr/local/libexec/gram-owner-fs-entry', str(self.root), '/run/gram-owner-fs/runtime', '--',
                          '/run/gram-owner-fs/runtime/bin/node', '/usr/local/libexec/gram-owner-fs-worker.mjs', str(self.root), str(self.vault)]

    def call(self, operation, **fields):
        if operation in ('write', 'move', 'mkdir', 'trash', 'restore'):
            fields.setdefault('expectedRootIdentity', self.call('stat')['identity'])
            if operation in ('write', 'move') and fields.get('expectedKind') != 'directory':
                fields.setdefault('expectedFileIdentity', None if fields.get('expectedBase64') is None else
                                  self.call('stat', path=fields['path']).get('identity', '0:0'))
        request = dict(operation=operation, root=str(self.root), path='.', protectedPaths=[])
        if operation in ('write', 'trash', 'restore'):
            st = self.vault.stat()
            request.update(recoveryRoot=str(self.vault), expectedRecoveryRootIdentity=f'{st.st_dev}:{st.st_ino}')
        request.update(fields)
        result = subprocess.run(self.sandbox(), input=json.dumps(request), text=True,
                                capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertLessEqual(len(result.stdout), 4 * 1024 * 1024)
        reply = json.loads(result.stdout)
        if not reply['ok']:
            self.assertIn(reply['code'], ('NO_CHANGE', 'OUTCOME_UNKNOWN'))
        return reply

    def test_real_list_stat_binary_read_and_mkdir(self):
        (self.root / '.hidden').write_bytes(b'\x00\xffbinary')
        listing = self.call('list')
        self.assertEqual(listing['entries'], [{'name': '.hidden', 'type': 'file'}])
        self.assertIs(listing['omitted'], False)
        self.assertEqual(self.call('stat', path='.hidden')['kind'], 'file')
        self.assertEqual(self.call('read', path='.hidden')['base64'], ENC(b'\x00\xffbinary'))
        self.assertTrue(self.call('mkdir', path='new')['ok'])
        self.assertTrue((self.root / 'new').is_dir())

    def test_list_reports_reserved_and_protected_omissions(self):
        (self.root / 'visible').write_bytes(b'visible')
        reserved = self.root / '.gram-owner-fs-12345678-1234-1234-1234-123456789abc'
        reserved.write_bytes(b'preimage')
        listing = self.call('list')
        self.assertEqual(listing['entries'], [{'name': 'visible', 'type': 'file'}])
        self.assertIs(listing['omitted'], True)
        reserved.unlink()
        (self.root / 'protected').mkdir()
        listing = self.call('list', protectedPaths=['protected'])
        self.assertEqual(listing['entries'], [{'name': 'visible', 'type': 'file'}])
        self.assertIs(listing['omitted'], True)
        nested = self.root / 'nested'
        nested.mkdir()
        (nested / 'protected').write_bytes(b'private')
        listing = self.call('list', path='nested', protectedPaths=['nested/protected'])
        self.assertEqual(listing['entries'], [])
        self.assertIs(listing['omitted'], True)
        listing = self.call('list', path='nested', protectedPaths=['absent'])
        self.assertEqual(listing['entries'], [{'name': 'protected', 'type': 'file'}])
        self.assertIs(listing['omitted'], False)

    def test_directory_move_and_persistent_trash_restore(self):
        directory = self.root / 'tree'
        directory.mkdir()
        (directory / '.hidden').write_bytes(b'\x00\xfftree')
        os.setxattr(directory, 'user.directory', b'metadata')
        before = self.call('treeStat', path='tree')
        self.assertTrue(before['ok'], before)
        preimage = dict(expectedKind='directory', expectedVersion=before['version'], expectedFileIdentity=before['identity'])
        self.assertTrue(self.call('move', path='tree', destination='moved', **preimage)['ok'])
        self.assertEqual((self.root / 'moved/.hidden').read_bytes(), b'\x00\xfftree')
        self.assertTrue(self.call('trash', path='moved', recoveryId='recovery-directory', **preimage)['ok'])
        self.assertFalse((self.root / 'moved').exists())
        self.assertEqual((self.vault / 'recovery-directory/.hidden').read_bytes(), b'\x00\xfftree')
        self.assertTrue(self.call('restore', path='restored', recoveryId='recovery-directory', **preimage)['ok'])
        self.assertEqual(os.getxattr(self.root / 'restored', 'user.directory'), b'metadata')
        self.assertEqual((self.root / 'restored/.hidden').read_bytes(), b'\x00\xfftree')

    def test_file_trash_restore_never_overwrites_or_accepts_stale_preimage(self):
        target = self.root / 'file'
        target.write_bytes(b'original')
        st = target.stat()
        preimage = dict(expectedKind='file', expectedBase64=ENC(b'original'), expectedFileIdentity=f'{st.st_dev}:{st.st_ino}')
        self.assertTrue(self.call('trash', path='file', recoveryId='recovery-file', **preimage)['ok'])
        target.write_bytes(b'new-writer')
        self.assertFalse(self.call('restore', path='file', recoveryId='recovery-file', **preimage)['ok'])
        self.assertEqual(target.read_bytes(), b'new-writer')
        self.assertEqual((self.vault / 'recovery-file').read_bytes(), b'original')

    def test_tree_preimage_conflicts_links_and_vault_identity_fail_closed(self):
        directory = self.root / 'tree'
        directory.mkdir()
        target = directory / 'file'
        target.write_bytes(b'original')
        before = self.call('treeStat', path='tree')
        preimage = dict(expectedKind='directory', expectedVersion=before['version'], expectedFileIdentity=before['identity'])
        target.write_bytes(b'other-writer')
        stale = self.call('move', path='tree', destination='moved', **preimage)
        self.assertEqual(stale, {'ok': False, 'code': 'NO_CHANGE'})
        self.assertEqual(target.read_bytes(), b'other-writer')
        current = self.call('treeStat', path='tree')
        preimage.update(expectedVersion=current['version'])
        denied = self.call('trash', path='tree', recoveryId='capture', expectedRecoveryRootIdentity='0:0', **preimage)
        self.assertEqual(denied, {'ok': False, 'code': 'NO_CHANGE'})
        self.assertTrue(directory.exists())
        (directory / 'link').symlink_to(self.outside)
        self.assertFalse(self.call('treeStat', path='tree')['ok'])
        (directory / 'link').unlink()
        os.link(target, directory / 'hard')
        self.assertFalse(self.call('treeStat', path='tree')['ok'])

    def test_readonly_file_replacement_and_parent_authorized_rename(self):
        target = self.root / 'readonly'
        target.write_bytes(b'original')
        target.chmod(0o400)
        changed = self.call('write', path='readonly', expectedBase64=ENC(b'original'), base64=ENC(b'changed'))
        self.assertTrue(changed['ok'], changed)
        self.assertEqual(target.stat().st_mode & 0o7777, 0o400)
        st = target.stat()
        preimage = dict(expectedKind='file', expectedBase64=ENC(b'changed'), expectedFileIdentity=f'{st.st_dev}:{st.st_ino}')
        moved = self.call('trash', path='readonly', recoveryId='readonly-capture', **preimage)
        self.assertTrue(moved['ok'], moved)
        self.assertEqual((self.vault / 'readonly-capture').stat().st_mode & 0o7777, 0o400)

    def test_write_preserves_mode_xattrs_and_captured_preimage(self):
        target = self.root / 'file'
        target.write_bytes(b'original')
        original_identity = f'{target.stat().st_dev}:{target.stat().st_ino}'
        target.chmod(0o640)
        os.setxattr(target, 'user.fixture', b'\x00metadata\xff')
        # Real POSIX ACL, including a named user and its mask, without setfacl.
        acl = struct.pack('<I', 2) + b''.join(struct.pack('<HHI', tag, perm, uid)
            for tag, perm, uid in ((1, 6, 0xffffffff), (2, 4, os.getuid()),
                                  (4, 4, 0xffffffff), (16, 4, 0xffffffff), (32, 0, 0xffffffff)))
        os.setxattr(target, 'system.posix_acl_access', acl)
        result = self.call('write', path='file', expectedBase64=ENC(b'original'), base64=ENC(b'new'))
        self.assertTrue(result['ok'], result)
        self.assertEqual(target.read_bytes(), b'new')
        self.assertEqual(target.stat().st_mode & 0o7777, 0o640)
        self.assertEqual(os.getxattr(target, 'user.fixture'), b'\x00metadata\xff')
        self.assertEqual(os.getxattr(target, 'system.posix_acl_access'), acl)
        self.assertEqual((self.recovery / 'preimage').read_bytes(), b'original')
        self.assertEqual(os.getxattr(self.recovery / 'preimage', 'user.fixture'), b'\x00metadata\xff')
        self.assertEqual(list(self.root.glob('.gram-owner-fs-*')), [])
        mapping = json.loads((self.recovery / 'mapping.json').read_text())
        captured = self.vault / mapping['entry']
        self.assertEqual(captured.read_bytes(), b'original')
        self.assertEqual(f'{captured.stat().st_dev}:{captured.stat().st_ino}', original_identity)
        self.assertEqual(captured.stat().st_mode & 0o7777, 0o640)
        self.assertEqual(os.getxattr(captured, 'system.posix_acl_access'), acl)

    def test_create_and_move_do_not_overwrite(self):
        self.assertTrue(self.call('write', path='source', expectedBase64=None, base64=ENC(b'source'))['ok'])
        self.assertTrue(self.call('move', path='source', destination='moved', expectedBase64=ENC(b'source'))['ok'])
        self.assertFalse((self.root / 'source').exists())
        (self.root / 'other').write_bytes(b'other')
        self.assertFalse(self.call('move', path='moved', destination='other', expectedBase64=ENC(b'source'))['ok'])
        self.assertEqual((self.root / 'other').read_bytes(), b'other')
        self.assertFalse(self.call('write', path='other', expectedBase64=None, base64=ENC(b'clobber'))['ok'])
        self.assertEqual((self.root / 'other').read_bytes(), b'other')

    def test_links_protected_paths_and_typed_input_denial(self):
        target = self.root / 'file'
        target.write_bytes(b'fixture')
        os.link(target, self.root / 'hard')
        (self.root / 'link').symlink_to('/usr/bin')
        for name in ('hard', 'link/true', '../outside', '/etc/passwd', 'x:stream'):
            self.assertFalse(self.call('read', path=name)['ok'], name)
        self.assertFalse(self.call('mkdir', path='controller', protectedMutationPaths=['controller/auth'])['ok'])
        (self.root / 'private').write_bytes(b'private')
        self.assertFalse(self.call('read', path='private', protectedPaths=['private'])['ok'])
        self.assertTrue(self.call('read', path='private', protectedMutationPaths=['private'])['ok'])
        self.assertFalse(self.call('exec', path='.', command='true')['ok'])

    def test_stale_identity_and_preimage_are_no_change(self):
        target = self.root / 'file'
        target.write_bytes(b'actual')
        for extra in ({'expectedRootIdentity': '0:0'}, {'expectedFileIdentity': '0:0'}, {}):
            reply = self.call('write', path='file', expectedBase64=ENC(b'stale'), base64=ENC(b'new'), **extra)
            self.assertEqual(reply, {'ok': False, 'code': 'NO_CHANGE'})
            self.assertEqual(target.read_bytes(), b'actual')

    def test_symlink_swap_race_never_modifies_outside(self):
        sentinel = self.outside / 'sentinel'
        sentinel.write_bytes(b'outside')
        real = self.root / 'real'
        real.mkdir()
        (real / 'sentinel').write_bytes(b'inside')
        alias = self.root / 'alias'
        stop = threading.Event()
        def swap():
            while not stop.is_set():
                try:
                    alias.symlink_to(self.outside)
                    alias.unlink()
                    alias.mkdir()
                    alias.rmdir()
                except FileExistsError:
                    pass
        thread = threading.Thread(target=swap)
        thread.start()
        try:
            for _ in range(8):
                self.assertFalse(self.call('read', path='alias/sentinel')['ok'])
        finally:
            stop.set()
            thread.join()
        self.assertEqual(sentinel.read_bytes(), b'outside')

    def test_profile_denies_network_and_outside_filesystem(self):
        # An adversarial fixture at the entry's immutable worker path exercises
        # the actual profile independently of production worker validation.
        script = self.base / 'profile-probe.mjs'
        script.write_text("import fs from 'node:fs'; import net from 'node:net';\n"
                          f"try {{ fs.writeFileSync({json.dumps(str(self.outside / 'sentinel'))},'changed'); process.exit(2); }}\n"
                          "catch(e) { if(e.code!=='EACCES' && e.code!=='EPERM') process.exit(3); }\n"
                          "const s=net.createServer(); s.on('error',e=> { console.log(e.code); "
                          "if(e.code!=='EPERM') process.exitCode=4; }); s.listen(12345,'127.0.0.1');\n")
        sentinel = self.outside / 'sentinel'
        sentinel.write_bytes(b'outside')
        command = self.sandbox()
        insertion = command.index('--clearenv')
        command[insertion:insertion] = ['--ro-bind', str(script), '/usr/local/libexec/gram-owner-fs-worker.mjs']
        result = subprocess.run(command, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'EPERM')
        self.assertEqual(sentinel.read_bytes(), b'outside')

    def test_recovery_symlink_and_privileged_file_denial(self):
        target = self.root / 'file'
        target.write_bytes(b'original')
        self.recovery.rmdir()
        self.recovery.symlink_to(self.outside)
        result = self.call('write', path='file', expectedBase64=ENC(b'original'), base64=ENC(b'new'))
        self.assertEqual(result, {'ok': False, 'code': 'NO_CHANGE'})
        self.assertEqual(target.read_bytes(), b'original')
        target.chmod(0o4640)
        self.assertFalse(self.call('read', path='file')['ok'])

    def test_filesystem_profile_revokes_moved_directory_create(self):
        parent = self.root / 'parent'
        parent.mkdir()
        script = self.base / 'moved-parent-probe.mjs'
        script.write_text("import fs from 'node:fs';\n"
                          f"const fd=fs.openSync({json.dumps(str(parent))},fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);\n"
                          "fs.writeSync(1,'READY\\n'); fs.readSync(0,Buffer.alloc(1),0,1,null);\n"
                          "try { fs.writeFileSync('/proc/self/fd/'+fd+'/escaped','changed'); process.exit(2); }\n"
                          "catch(e) { console.log(e.code); if(e.code!=='EACCES' && e.code!=='EPERM') process.exitCode=3; }\n")
        command = self.sandbox()
        insertion = command.index('--clearenv')
        command[insertion:insertion] = ['--ro-bind', str(script), '/usr/local/libexec/gram-owner-fs-worker.mjs']
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True)
        try:
            ready = process.stdout.readline()
            if ready != 'READY\n':
                output, errors = process.communicate(timeout=20)
                self.fail(f'probe did not start: {ready!r} {output!r} {errors!r}')
            parent.rename(self.outside / 'moved')
            output, errors = process.communicate('x', timeout=20)
            self.assertEqual(process.returncode, 0, errors)
            self.assertIn(output.strip(), ('EACCES', 'EPERM'))
            self.assertFalse((self.outside / 'moved/escaped').exists())
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()

    def test_unknown_outcome_keeps_reserved_evidence(self):
        # A no-replace collision happens after the real temporary file write.
        # The result must quarantine, rather than certify that nothing changed.
        target = self.root / 'existing'
        target.write_bytes(b'original')
        result = self.call('write', path='existing', expectedBase64=None, base64=ENC(b'new'))
        self.assertEqual(result, {'ok': False, 'code': 'OUTCOME_UNKNOWN'})
        self.assertEqual(target.read_bytes(), b'original')
        evidence = list(self.root.glob('.gram-owner-fs-*'))
        self.assertEqual(len(evidence), 1)
        self.assertEqual(evidence[0].read_bytes(), b'new')
        self.assertEqual(self.call('list')['entries'], [{'name': 'existing', 'type': 'file'}])

    def test_original_path_landlock_revokes_moved_directory_create(self):
        # Architecture probe: a full filesystem-root mount preserves the real
        # ancestor chain, unlike mounting the selected directory as mount root.
        parent = self.root / 'parent'
        parent.mkdir()
        script = self.base / 'original-path-probe.mjs'
        script.write_text("import fs from 'node:fs';\n"
                          f"const fd=fs.openSync({json.dumps(str(parent))},fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);\n"
                          "fs.writeSync(1,'READY\\n'); fs.readSync(0,Buffer.alloc(1),0,1,null);\n"
                          "try { fs.writeFileSync('/proc/self/fd/'+fd+'/escaped','changed'); process.exit(2); }\n"
                          "catch(e) { console.log(e.code); if(e.code!=='EACCES' && e.code!=='EPERM') process.exitCode=3; }\n")
        command = ['bwrap', '--unshare-all', '--die-with-parent', '--new-session',
                   '--bind', '/', '/', '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib',
                   '--ro-bind', '/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev',
                   '--ro-bind', str(RUNTIME), str(RUNTIME),
                   '--ro-bind', str(self.bin), '/usr/local/libexec',
                   '--ro-bind', str(script), '/usr/local/libexec/gram-owner-fs-worker.mjs', '--clearenv',
                   '--setenv', 'OPENSSL_CONF', '/dev/null',
                   '--setenv', 'HOME', '/home/gram-sandbox', '--setenv', 'LANG', 'C',
                   '--chdir', str(self.root), '/usr/local/libexec/ordinary', str(self.root), str(RUNTIME), '--',
                   str(RUNTIME / 'bin/node'), '/usr/local/libexec/gram-owner-fs-worker.mjs']
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True)
        try:
            ready = process.stdout.readline()
            if ready != 'READY\n':
                output, errors = process.communicate(timeout=20)
                self.fail(f'probe did not start: {ready!r} {output!r} {errors!r}')
            parent.rename(self.outside / 'moved')
            output, errors = process.communicate('x', timeout=20)
            self.assertEqual(process.returncode, 0, errors)
            self.assertIn(output.strip(), ('EACCES', 'EPERM'))
            self.assertFalse((self.outside / 'moved/escaped').exists())
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()

    def test_ordinary_m5_hash_and_metadata_network_denial(self):
        # Both builds use this machine's identical compiler and flags. Historical
        # source integrity is pinned above; a toolchain-specific ELF digest is not.
        self.assertEqual((self.bin / 'ordinary').read_bytes(),
                         (self.bin / 'ordinary-historical').read_bytes())
        # Use the ordinary entry's existing fixed /usr/bin executable contract.
        # Bind the compiled probe at that allowed path inside this isolated mount namespace.
        command = self.sandbox(ordinary=True)
        insertion = command.index('--clearenv')
        command[insertion:insertion] = ['--ro-bind', str(self.bin / 'probe'), command[-1]]
        result = subprocess.run(command, capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
