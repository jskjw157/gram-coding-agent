"""Real Windows fixture tests. Invoke with the fixed helper executable path.

These exercise native filesystem effects, not mocked authorization or production
state. The helper is not deployed by this test.
"""
import base64
import ctypes
from ctypes import wintypes
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

HELPER = pathlib.Path(sys.argv.pop(1)).resolve() if len(sys.argv) > 1 else None


def vault_security(path, user=None):
    """Install an exact fixture DACL, or inspect safe native ACL metadata."""
    advapi = ctypes.WinDLL('advapi32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    pointer = ctypes.c_void_p
    advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(pointer), ctypes.POINTER(wintypes.DWORD)]
    advapi.GetSecurityDescriptorDacl.argtypes = [pointer, ctypes.POINTER(wintypes.BOOL),
                                               ctypes.POINTER(pointer), ctypes.POINTER(wintypes.BOOL)]
    advapi.SetNamedSecurityInfoW.argtypes = [wintypes.LPWSTR, ctypes.c_int, wintypes.DWORD,
                                           pointer, pointer, pointer, pointer]
    advapi.SetNamedSecurityInfoW.restype = wintypes.DWORD
    advapi.GetNamedSecurityInfoW.argtypes = [wintypes.LPWSTR, ctypes.c_int, wintypes.DWORD,
                                           pointer, pointer, ctypes.POINTER(pointer), pointer, ctypes.POINTER(pointer)]
    advapi.GetNamedSecurityInfoW.restype = wintypes.DWORD
    advapi.GetSecurityDescriptorControl.argtypes = [pointer, ctypes.POINTER(wintypes.WORD), ctypes.POINTER(wintypes.DWORD)]
    advapi.ConvertSecurityDescriptorToStringSecurityDescriptorW.argtypes = [
        pointer, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(pointer), ctypes.POINTER(wintypes.DWORD)]
    advapi.GetAce.argtypes = [pointer, wintypes.DWORD, ctypes.POINTER(pointer)]
    advapi.ConvertSidToStringSidW.argtypes = [pointer, ctypes.POINTER(pointer)]
    kernel.LocalFree.argtypes = [pointer]
    kernel.LocalFree.restype = pointer
    descriptor, acl, text = pointer(), pointer(), pointer()
    try:
        if user is not None:
            sddl = f'D:P(A;OICI;FA;;;{user})'
            if not advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(descriptor), None):
                raise ctypes.WinError(ctypes.get_last_error())
            present, defaulted = wintypes.BOOL(), wintypes.BOOL()
            if not advapi.GetSecurityDescriptorDacl(descriptor, ctypes.byref(present), ctypes.byref(acl), ctypes.byref(defaulted)):
                raise ctypes.WinError(ctypes.get_last_error())
            if not present.value or not acl.value:
                raise AssertionError('fixture DACL missing')
            error = advapi.SetNamedSecurityInfoW(str(path), 1, 0x80000004, None, None, acl, None)
            if error:
                raise ctypes.WinError(error)
            kernel.LocalFree(descriptor)
            descriptor = pointer()
        error = advapi.GetNamedSecurityInfoW(str(path), 1, 4, None, None, ctypes.byref(acl), None, ctypes.byref(descriptor))
        if error:
            raise ctypes.WinError(error)
        control, revision = wintypes.WORD(), wintypes.DWORD()
        if not advapi.GetSecurityDescriptorControl(descriptor, ctypes.byref(control), ctypes.byref(revision)):
            raise ctypes.WinError(ctypes.get_last_error())
        if not advapi.ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, 1, 4, ctypes.byref(text), None):
            raise ctypes.WinError(ctypes.get_last_error())
        aces = []
        count = int.from_bytes(ctypes.string_at(acl, 8)[4:6], 'little')
        for index in range(count):
            ace, sid_text = pointer(), pointer()
            if not advapi.GetAce(acl, index, ctypes.byref(ace)):
                raise ctypes.WinError(ctypes.get_last_error())
            header = ctypes.string_at(ace, 8)
            if header[0] != 0:  # The fixture requires only ordinary allow ACEs.
                raise AssertionError('unexpected fixture ACE type')
            if not advapi.ConvertSidToStringSidW(ace.value + 8, ctypes.byref(sid_text)):
                raise ctypes.WinError(ctypes.get_last_error())
            try:
                aces.append({'type': header[0], 'flags': header[1],
                             'mask': int.from_bytes(header[4:8], 'little'), 'sid': ctypes.wstring_at(sid_text)})
            finally:
                kernel.LocalFree(sid_text)
        st = path.stat()
        return {'sddl': ctypes.wstring_at(text), 'protected': bool(control.value & 0x1000),
                'aces': aces, 'attributes': st.st_file_attributes, 'volume': st.st_dev, 'identity': st.st_ino}
    finally:
        if text.value:
            kernel.LocalFree(text)
        if descriptor.value:
            kernel.LocalFree(descriptor)


class WindowsWorkspace(unittest.TestCase):
    def setUp(self):
        self.fixture = tempfile.TemporaryDirectory(prefix="gram-native-workspace-")
        self.base = pathlib.Path(self.fixture.name)
        self.root = self.base / "root"
        self.root.mkdir()
        self.recovery = self.base / "private-recovery"
        self.recovery.mkdir()
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.SetFileAttributesW.argtypes = [ctypes.c_wchar_p, ctypes.c_ulong]
        self.assertTrue(kernel.SetFileAttributesW(str(self.recovery), 2))
        user = subprocess.run(['whoami.exe', '/user', '/fo', 'csv', '/nh'],
                              capture_output=True, text=True, check=True).stdout.strip().split(',')[-1].strip('"')
        self.user_sid = user
        # Replacing the DACL also clears explicit OWNER RIGHTS or other ACEs;
        # icacls /inheritance:r /grant:r only removes inherited and matching ACEs.
        security = vault_security(self.recovery, user)
        self.assertTrue(security['protected'], security)
        self.assertEqual(security['aces'], [{'type': 0, 'flags': 3, 'mask': 0x1f01ff, 'sid': user}], security)

    def tearDown(self):
        self.fixture.cleanup()

    def call(self, operation, **fields):
        if operation in ('write', 'move', 'mkdir'):
            fields.setdefault('expectedRootIdentity', self.call('stat', path='.')['identity'])
            if operation != 'mkdir':
                fields.setdefault('expectedFileIdentity', None if fields.get('expectedBase64') is None else self.call('stat', path=fields['path']).get('identity', '0:0'))
        request = {"operation": operation, "root": str(self.root), "path": ".",
                   "protectedPaths": [str(self.recovery)], **fields}
        result = subprocess.run([str(HELPER)], input=json.dumps(request), text=True, encoding="utf-8",
                                capture_output=True, timeout=10, check=False)
        self.assertLessEqual(len(result.stdout.encode("utf-8")), 4 * 1024 * 1024 + 1)
        reply = json.loads(result.stdout)
        if operation in ('trash', 'restore') and not reply['ok']:
            reply['fixtureSecurity'] = dict(vault_security(self.recovery), currentSid=self.user_sid,
                                            rootVolume=self.root.stat().st_dev)
        return reply

    def test_project_guard_allows_only_identity_pinned_project_reads(self):
        project = self.root / 'project'
        project.mkdir()
        (project / 'file').write_bytes(b'guarded-fixture')
        guard = dict(projectPath='PROJECT', expectedProjectIdentity=self.call('stat', path='project')['identity'])
        for operation, path in [('stat', 'project'), ('list', 'project'),
                                ('stat', 'project/file'), ('read', 'project/file')]:
            self.assertEqual(self.call(operation, path=path, **guard), self.call(operation, path=path))
        for operation in ['stat', 'read']:
            items = [dict(operation=operation, path='project/file')] * 2
            reply = self.call('readBatch', items=items, **guard)
            self.assertTrue(reply['ok'], reply)
            self.assertEqual(reply['results'], [self.call(operation, path='project/file')] * 2)
        self.assertEqual(self.call('read', path='project/file', protectedPaths=[str(project)], **guard),
                         dict(ok=False, code='DENIED_NO_CHANGE'))
        root_guard = dict(projectPath='.', expectedProjectIdentity=self.call('stat')['identity'])
        self.assertEqual(self.call('read', path='project/file', **root_guard),
                         self.call('read', path='project/file'))
        pack_dir = project / '.git/objects/pack'
        pack_dir.mkdir(parents=True)
        relative = 'project/.git/objects/pack/pack-' + 'd' * 40 + '.pack'
        (self.root / relative).write_bytes(b'P' * (1024 * 1024 + 1))
        item = dict(operation='readGitChunk', path=relative, offset=0, length=262144)
        expected = self.call(**item)
        self.assertEqual(self.call(**item, **guard), expected)
        self.assertEqual(self.call('readBatch', items=[item, item], **guard),
                         dict(ok=True, results=[expected, expected]))

    def test_project_guard_rejects_incomplete_invalid_and_outside_context(self):
        project = self.root / 'project'
        project.mkdir()
        (project / 'file').write_bytes(b'guarded-fixture')
        (self.root / 'outside').write_bytes(b'outside-fixture')
        guard = dict(projectPath='project', expectedProjectIdentity=self.call('stat', path='project')['identity'])
        invalid = [dict(projectPath='project'), dict(expectedProjectIdentity=guard['expectedProjectIdentity']),
                   dict(guard, projectPath='../project'), dict(guard, projectPath='project/file'),
                   dict(guard, projectPath=1), dict(guard, expectedProjectIdentity=1),
                   dict(guard, expectedProjectIdentity='0:0'), dict(guard, expectedProjectIdentity='a:b'),
                   dict(guard, expectedProjectIdentity='1:2:3'), dict(guard, expectedProjectIdentity=':1'),
                   dict(guard, expectedProjectIdentity='1:'), dict(guard, projectPath='')]
        for fields in invalid:
            for operation in ['read', 'stat']:
                with self.subTest(fields=fields, operation=operation):
                    item = dict(operation=operation, path='project/file')
                    self.assertEqual(self.call(**item, **fields), dict(ok=False, code='DENIED_NO_CHANGE'))
                    self.assertEqual(self.call('readBatch', items=[item, item], **fields),
                                     dict(ok=False, code='DENIED_NO_CHANGE'))
        for path in ['outside', '.', 'project-sibling/file']:
            self.assertEqual(self.call('stat', path=path, **guard), dict(ok=False, code='DENIED_NO_CHANGE'))
        self.assertEqual(self.call('readBatch', items=[dict(operation='stat', path='project/file'),
                                                     dict(operation='stat', path='outside')], **guard),
                         dict(ok=False, code='DENIED_NO_CHANGE'))
        for fields in [guard, dict(projectPath='project'), dict(expectedProjectIdentity='0:0')]:
            self.assertEqual(self.call('readBatch', items=[dict(operation='read', path='project/file', **fields)],
                                       **guard), dict(ok=False, code='DENIED_NO_CHANGE'))

    def test_project_guard_rejects_renamed_replaced_and_junction_projects(self):
        project = self.root / 'project'
        project.mkdir()
        (project / 'file').write_bytes(b'original-fixture')
        guard = dict(projectPath='project', expectedProjectIdentity=self.call('stat', path='project')['identity'])
        project.rename(self.root / 'original')
        project.mkdir()
        (project / 'file').write_bytes(b'replacement-fixture')
        for operation, path in [('read', 'project/file'), ('stat', 'project'), ('list', 'project')]:
            self.assertEqual(self.call(operation, path=path, **guard), dict(ok=False, code='DENIED_NO_CHANGE'))
        junction = self.root / 'junction'
        made = subprocess.run(['cmd.exe', '/d', '/c', 'mklink', '/J', str(junction), str(self.root / 'original')],
                              capture_output=True)
        self.assertEqual(made.returncode, 0)
        try:
            self.assertEqual(self.call('read', path='junction/file', **dict(guard, projectPath='junction')),
                             dict(ok=False, code='DENIED_NO_CHANGE'))
        finally:
            junction.rmdir()
        self.assertEqual((self.root / 'original/file').read_bytes(), b'original-fixture')

    def test_project_guard_is_rejected_on_mutations(self):
        (self.root / 'file').write_bytes(b'preserved')
        guard = dict(projectPath='.', expectedProjectIdentity=self.call('stat')['identity'])
        for fields in [guard, dict(projectPath='.'), dict(expectedProjectIdentity=guard['expectedProjectIdentity'])]:
            self.assertFalse(self.call('write', path='file', expectedBase64=base64.b64encode(b'preserved').decode(),
                                       base64=base64.b64encode(b'changed').decode(), **fields)['ok'])
            self.assertFalse(self.call('mkdir', path='created', **fields)['ok'])
        self.assertEqual((self.root / 'file').read_bytes(), b'preserved')
        self.assertFalse((self.root / 'created').exists())
        (self.root / 'tree').mkdir()
        self.assertTrue(self.call('treeStat', path='tree')['ok'])
        self.assertEqual(self.call('treeStat', path='tree', **guard), dict(ok=False, code='DENIED_NO_CHANGE'))

    def test_read_batch_preserves_order_original_replies_and_shared_policy(self):
        (self.root / 'one').write_bytes(b'first' + b'x' * (1024 * 1024 - 5))
        (self.root / 'two').write_bytes(b'second' + b'y' * (1024 * 1024 - 6))
        for operation, paths in [('stat', ['two', '.', 'one']), ('read', ['two', 'one'])]:
            items = [dict(operation=operation, path=path) for path in paths]
            reply = self.call('readBatch', items=items,
                              protectedMutationPaths=[str(self.root)])
            self.assertTrue(reply['ok'], reply)
            self.assertEqual(reply['results'], [self.call(operation, path=path) for path in paths])
        self.assertTrue(self.call('readBatch', items=[dict(operation='stat', path='.')] * 16)['ok'])

    def test_read_batch_git_pack_chunks_keep_order_and_original_metadata(self):
        pack_dir = self.root / '.git/objects/pack'
        pack_dir.mkdir(parents=True)
        relative = '.git/objects/pack/pack-' + 'b' * 40 + '.pack'
        contents = bytes(range(256)) * 8192
        (self.root / relative).write_bytes(contents)
        items = [dict(operation='readGitChunk', path=relative, offset=i * 262144, length=262144)
                 for i in reversed(range(8))]
        reply = self.call('readBatch', items=items)
        self.assertTrue(reply['ok'], reply)
        self.assertEqual(reply['results'], [self.call(**item) for item in items])
        self.assertEqual(base64.b64decode(reply['results'][0]['base64']), contents[-262144:])

    def test_read_batch_rejects_invalid_envelopes_and_items_without_effects(self):
        target = self.root / 'file'
        target.write_bytes(b'preserved')
        stat = dict(operation='stat', path='file')
        bad_items = [[], [stat] * 17, [dict(operation='read', path='file')] * 3,
                     [dict(operation='readGitChunk', path='file', offset=0, length=1)] * 9,
                     [stat, dict(operation='read', path='file')],
                     [dict(operation='list', path='.')],
                     [dict(operation='readBatch', path='.', items=[stat])]]
        for operation in ['write', 'mkdir', 'move', 'trash', 'restore', 'treeStat', 'exec']:
            bad_items.append([stat, dict(operation=operation, path='file')])
        for key, value in [('root', str(self.base)), ('protectedPaths', []),
                           ('protectedMutationPaths', []), ('unknown', True),
                           ('offset', 0), ('length', 1)]:
            bad_items.append([dict(stat, **{key: value})])
        bad_items += [[dict(operation='stat')], [dict(path='file')], [None], ['file']]
        pack = '.git/objects/pack/pack-' + 'c' * 40 + '.pack'
        for fields in [dict(offset=-1, length=1), dict(offset=0.5, length=1),
                       dict(offset=0, length=262145), dict(offset=0, length=1.5),
                       dict(offset='0', length=1), dict(offset=0)]:
            bad_items.append([dict(operation='readGitChunk', path=pack, **fields)])
        for items in bad_items:
            with self.subTest(items=items):
                self.assertEqual(self.call('readBatch', items=items),
                                 dict(ok=False, code='DENIED_NO_CHANGE'))
                self.assertEqual(target.read_bytes(), b'preserved')
        for fields in [dict(path='file'), dict(unknown=True), dict(offset=0), dict(items=None)]:
            with self.subTest(fields=fields):
                self.assertEqual(self.call('readBatch', **dict(dict(items=[stat]), **fields)),
                                 dict(ok=False, code='DENIED_NO_CHANGE'))

    def test_read_batch_failure_omits_all_partial_results(self):
        (self.root / 'file').write_bytes(b'fixture')
        reply = self.call('readBatch', items=[dict(operation='read', path='file'),
                                             dict(operation='read', path='missing')])
        self.assertEqual(reply, dict(ok=False, code='DENIED_NO_CHANGE'))

    def test_read_batch_keeps_protected_child_hardlink_traversal_and_alias_guards(self):
        private = self.root / 'private'
        private.mkdir()
        secret = private / 'fixture'
        secret.write_bytes(b'synthetic-private-fixture')
        (self.root / 'ordinary').write_bytes(b'ordinary-fixture')
        (self.root / 'hardlink').hardlink_to(secret)
        junction = self.root / 'alias'
        made = subprocess.run(['cmd.exe', '/d', '/c', 'mklink', '/J', str(junction), str(private)],
                              capture_output=True)
        self.assertEqual(made.returncode, 0)
        try:
            for operation in ['stat', 'read']:
                for path in ['private/fixture', 'PRIVATE/fixture', 'hardlink', '../private/fixture',
                             'alias/fixture', 'ordinary:stream']:
                    with self.subTest(operation=operation, path=path):
                        self.assertEqual(self.call('readBatch', protectedPaths=[str(private)],
                                                  items=[dict(operation=operation, path='ordinary'),
                                                         dict(operation=operation, path=path)]),
                                         dict(ok=False, code='DENIED_NO_CHANGE'))
        finally:
            junction.rmdir()
        self.assertEqual(secret.read_bytes(), b'synthetic-private-fixture')

    def test_native_response_utf8_budget_is_checked_before_any_stdout(self):
        # NTFS filenames count UTF-16 units; UTF-8 output can be three times larger.
        long_root = pathlib.Path('\\\\?\\' + str(self.root))
        try:
            for index in range(6100):
                (long_root / (str(index) + '\u754c' * 240)).touch()
            self.assertEqual(self.call('list'), dict(ok=False, code='DENIED_NO_CHANGE'))
        finally:
            for path in long_root.iterdir():
                path.unlink()

    def test_git_pack_chunk_is_bounded_and_native_identity_is_stable(self):
        pack_dir = self.root / '.git' / 'objects' / 'pack'
        pack_dir.mkdir(parents=True)
        name = 'pack-' + ('a' * 40) + '.pack'
        pack_path = pack_dir / name
        contents = b'PACK' + bytes((i % 251 for i in range(1024 * 1024 + 8192 - 4)))
        pack_path.write_bytes(contents)
        relative = '.git/objects/pack/' + name
        one = self.call('readGitChunk', path=relative, offset=0, length=262144)
        self.assertTrue(one['ok'], one)
        self.assertEqual(base64.b64decode(one['base64']), contents[:262144])
        self.assertEqual(one['totalBytes'], len(contents))
        two = self.call('readGitChunk', path=relative, offset=262144, length=262144)
        self.assertTrue(two['ok'], two)
        self.assertEqual(one['identity'], two['identity'])
        self.assertEqual(one['gitStamp'], two['gitStamp'])
        self.assertEqual(base64.b64decode(two['base64']), contents[262144:524288])
        self.assertFalse(self.call('readGitChunk', path=relative, offset=0, length=262145)['ok'])
        self.assertFalse(self.call('readGitChunk', path=relative, offset=len(contents), length=1)['ok'])
        (self.root / 'secret.bin').write_bytes(contents)
        self.assertFalse(self.call('readGitChunk', path='secret.bin', offset=0, length=1024)['ok'])
        self.assertFalse(self.call('read', path=relative)['ok'])

    def test_real_hidden_binary_read_and_list(self):
        (self.root / ".env").write_bytes(b"SAFE=enabled\n")
        binary = b"\x00\x01\xff\x89PNG"
        (self.root / "image.bin").write_bytes(binary)
        listing = self.call('list')
        self.assertEqual({item['name'] for item in listing['entries']}, {'.env', 'image.bin'})
        self.assertIs(listing['omitted'], False)
        self.assertEqual(base64.b64decode(self.call("read", path="image.bin")["base64"]), binary)

    def test_list_completeness_includes_reserved_and_protected_names(self):
        reserved = '.gram-owner-fs-12345678-1234-1234-1234-123456789abc'
        (self.root / reserved).write_bytes(b'fixture')
        protected = self.root / 'protected'
        protected.mkdir()
        listing = self.call('list', protectedPaths=[str(self.recovery), str(protected)])
        self.assertEqual({entry['name'] for entry in listing['entries']}, {reserved, 'protected'})
        self.assertIs(listing['omitted'], False)

    def test_actual_drive_root_is_browsable_without_project_hardcoding(self):
        result = self.call('list', root=self.root.anchor, path='.')
        self.assertTrue(result['ok'], result)
        self.assertIsInstance(result['entries'], list)

    def test_atomic_expected_preimage_write_and_permissions(self):
        target = self.root / "existing.txt"
        target.write_bytes(b"original")
        encoded = lambda value: base64.b64encode(value).decode("ascii")
        conflict = self.call("write", path="existing.txt", expectedBase64=encoded(b"wrong"), base64=encoded(b"new"))
        self.assertFalse(conflict["ok"])
        self.assertEqual(conflict['code'], 'DENIED_NO_CHANGE')
        self.assertEqual(target.read_bytes(), b"original")
        changed = self.call("write", path="existing.txt", expectedBase64=encoded(b"original"), base64=encoded(b"changed"))
        self.assertTrue(changed["ok"], changed)
        self.assertEqual(target.read_bytes(), b"changed")
        self.assertFalse(self.call("write", path="existing.txt", expectedBase64=None, base64=encoded(b"clobber"))["ok"])
        self.assertEqual(target.read_bytes(), b"changed")

    def test_hardlink_and_traversal_denial(self):
        target = self.root / "target.txt"
        target.write_bytes(b"fixture")
        (self.root / "alias.txt").hardlink_to(target)
        for name in ["alias.txt", "../outside", "x:stream", "CON", "trailing."]:
            with self.subTest(name=name):
                self.assertFalse(self.call("read", path=name)["ok"])

    def test_move_never_replaces_an_existing_destination(self):
        (self.root / "source").write_bytes(b"source")
        (self.root / "destination").write_bytes(b"destination")
        result = self.call("move", path="source", destination="destination", expectedBase64=base64.b64encode(b"source").decode("ascii"))
        self.assertFalse(result["ok"])
        self.assertEqual((self.root / "source").read_bytes(), b"source")
        self.assertEqual((self.root / "destination").read_bytes(), b"destination")

    def test_junction_and_protected_paths_are_not_followed(self):
        outside = self.base / "outside"
        outside.mkdir()
        (outside / "sentinel.txt").write_bytes(b"outside-fixture")
        junction = self.root / "link"
        result = subprocess.run(["cmd.exe", "/d", "/c", "mklink", "/J", str(junction), str(outside)],
                                capture_output=True, check=False)
        self.assertEqual(result.returncode, 0)
        try:
            self.assertFalse(self.call("read", path="link/sentinel.txt")["ok"])
            self.assertFalse(self.call("list", path="link")["ok"])
        finally:
            junction.rmdir()
        protected = self.root / "controller"
        protected.mkdir()
        (protected / "auth").write_bytes(b"synthetic-controller-fixture")
        self.assertFalse(self.call("read", path="controller/auth", protectedPaths=[str(protected)])["ok"])
        self.assertEqual((outside / "sentinel.txt").read_bytes(), b"outside-fixture")

    def test_valid_move_and_mkdir_have_real_effects(self):
        encoded = base64.b64encode(b"fixture").decode("ascii")
        self.assertTrue(self.call("mkdir", path="created")["ok"])
        self.assertTrue((self.root / "created").is_dir())
        (self.root / "source").write_bytes(b"fixture")
        result = self.call("move", path="source", destination="created/moved", expectedBase64=encoded)
        self.assertTrue(result["ok"], result)
        self.assertFalse((self.root / "source").exists())
        self.assertEqual((self.root / "created" / "moved").read_bytes(), b"fixture")

    def test_mutation_binds_root_and_file_identity_even_when_bytes_match(self):
        target = self.root / 'original'
        target.write_bytes(b'same-content')
        identity = self.call('stat', path='original')['identity']
        target.rename(self.root / 'preserved-original')
        target.write_bytes(b'same-content')
        self.assertNotEqual(self.call('stat', path='original')['identity'], identity)
        encoded = lambda value: base64.b64encode(value).decode('ascii')
        result = self.call('write', path='original', expectedBase64=encoded(b'same-content'),
                           base64=encoded(b'changed'), expectedFileIdentity=identity)
        self.assertFalse(result['ok'])
        result = self.call('write', path='original', expectedBase64=encoded(b'same-content'),
                           base64=encoded(b'changed'), expectedRootIdentity='0:0')
        self.assertFalse(result['ok'])
        self.assertEqual(target.read_bytes(), b'same-content')

    def test_drive_alias_cannot_bypass_a_protected_ancestor(self):
        private = self.root / 'controller'
        child = private / 'nested'
        child.mkdir(parents=True)
        (child / 'sentinel').write_bytes(b'private-alias-fixture')
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.DefineDosDeviceW.argtypes = [ctypes.c_ulong, ctypes.c_wchar_p, ctypes.c_wchar_p]
        kernel.DefineDosDeviceW.restype = ctypes.c_int
        drives = kernel.GetLogicalDrives()
        drive = next(chr(index + 65) + ':' for index in range(25, 3, -1) if not drives & (1 << index))
        target = str(child)
        self.assertTrue(kernel.DefineDosDeviceW(8, drive, target), ctypes.get_last_error())
        try:
            result = self.call('read', root=drive + '\\', path='sentinel', protectedPaths=[str(private)])
            self.assertFalse(result['ok'])
            for operation in ['stat', 'read']:
                reply = self.call('readBatch', root=drive + '\\', protectedPaths=[str(private)],
                                  items=[dict(operation=operation, path='sentinel')])
                self.assertEqual(reply, dict(ok=False, code='DENIED_NO_CHANGE'))
        finally:
            # Remove only our exact definition, preserving any other mappings.
            self.assertTrue(kernel.DefineDosDeviceW(8 | 2 | 4, drive, target), ctypes.get_last_error())

    def test_controller_code_is_readable_but_not_mutable(self):
        code = self.root / 'controller-code'
        code.mkdir()
        (code / 'main.js').write_bytes(b'fixed-controller-code')
        protected = {'protectedMutationPaths': [str(code)]}
        self.assertTrue(self.call('read', path='controller-code/main.js', **protected)['ok'])
        encoded = lambda value: base64.b64encode(value).decode('ascii')
        result = self.call('write', path='controller-code/main.js', expectedBase64=encoded(b'fixed-controller-code'),
                           base64=encoded(b'changed'), **protected)
        self.assertFalse(result['ok'])
        self.assertEqual((code / 'main.js').read_bytes(), b'fixed-controller-code')

    def test_directory_move_and_recovery_preserve_complete_tree(self):
        tree = self.root / 'tree'
        (tree / 'nested' / 'empty').mkdir(parents=True)
        (tree / 'nested' / '.hidden').write_bytes(b'\x00binary\xff')
        snapshot = self.call('treeStat', path='tree')
        self.assertTrue(snapshot['ok'], snapshot)
        fields = dict(expectedKind='directory', expectedVersion=snapshot['version'],
                      expectedFileIdentity=snapshot['identity'],
                      expectedRootIdentity=self.call('stat', path='.')['identity'])
        moved = self.call('move', path='tree', destination='moved', **fields)
        self.assertTrue(moved['ok'], moved)
        self.assertFalse(tree.exists())
        self.assertEqual((self.root / 'moved/nested/.hidden').read_bytes(), b'\x00binary\xff')
        self.assertTrue((self.root / 'moved/nested/empty').is_dir())
        snapshot = self.call('treeStat', path='moved')
        fields.update(expectedVersion=snapshot['version'])
        recovery = dict(recoveryRoot=str(self.recovery), recoveryId='fixture-recovery',
                        expectedRecoveryRootIdentity=self.call('stat', root=str(self.recovery), protectedPaths=[], path='.')['identity'])
        trashed = self.call('trash', path='moved', **fields, **recovery)
        self.assertTrue(trashed['ok'], trashed)
        self.assertFalse((self.root / 'moved').exists())
        self.assertFalse(self.call('list', root=str(self.recovery))['ok'])
        restored = self.call('restore', path='restored', **fields, **recovery)
        self.assertTrue(restored['ok'], restored)
        self.assertEqual((self.root / 'restored/nested/.hidden').read_bytes(), b'\x00binary\xff')
        self.assertTrue((self.root / 'restored/nested/empty').is_dir())

    def test_directory_move_rejects_changed_tree_existing_target_and_protected_ancestor(self):
        tree = self.root / 'tree'
        tree.mkdir()
        (tree / 'child').write_bytes(b'first')
        snapshot = self.call('treeStat', path='tree')
        self.assertTrue(snapshot['ok'], snapshot)
        fields = dict(expectedKind='directory', expectedVersion=snapshot['version'],
                      expectedFileIdentity=snapshot['identity'])
        (tree / 'child').write_bytes(b'changed')
        self.assertFalse(self.call('move', path='tree', destination='moved', **fields)['ok'])
        snapshot = self.call('treeStat', path='tree')
        fields['expectedVersion'] = snapshot['version']
        (self.root / 'occupied').mkdir()
        self.assertFalse(self.call('move', path='tree', destination='occupied', **fields)['ok'])
        for exclusion in ('protectedPaths', 'protectedMutationPaths'):
            self.assertFalse(self.call('move', path='tree', destination='moved',
                                       **fields, **{exclusion: [str(tree / 'child')]})['ok'])
        (tree / 'alias').hardlink_to(tree / 'child')
        self.assertFalse(self.call('treeStat', path='tree')['ok'])
        self.assertTrue(tree.is_dir())

    def test_file_recovery_is_private_version_bound_and_never_clobbers(self):
        target = self.root / 'file'
        target.write_bytes(b'preserve-file')
        fields = dict(expectedKind='file', expectedBase64=base64.b64encode(b'preserve-file').decode('ascii'),
                      expectedFileIdentity=self.call('stat', path='file')['identity'],
                      expectedRootIdentity=self.call('stat', path='.')['identity'],
                      recoveryRoot=str(self.recovery), recoveryId='file-recovery',
                      expectedRecoveryRootIdentity=self.call('stat', root=str(self.recovery), protectedPaths=[], path='.')['identity'])
        # A retained explicit OWNER RIGHTS ACE is outside the helper allowlist.
        grant = subprocess.run(['icacls.exe', str(self.recovery), '/grant', '*S-1-3-4:(OI)(CI)F'], capture_output=True)
        self.assertEqual(grant.returncode, 0)
        self.assertFalse(self.call('trash', path='file', **fields)['ok'])
        security = vault_security(self.recovery, self.user_sid)
        self.assertTrue(security['protected'], security)
        self.assertEqual(security['aces'], [{'type': 0, 'flags': 3, 'mask': 0x1f01ff, 'sid': self.user_sid}], security)
        trashed = self.call('trash', path='file', **fields)
        self.assertTrue(trashed['ok'], trashed)
        self.assertFalse(target.exists())
        self.assertFalse(self.call('read', root=str(self.recovery), path='file-recovery')['ok'])
        target.write_bytes(b'new-writer')
        self.assertFalse(self.call('restore', path='file', **fields)['ok'])
        self.assertEqual(target.read_bytes(), b'new-writer')
        self.assertEqual((self.recovery / 'file-recovery').read_bytes(), b'preserve-file')
        target.unlink()
        tampered = dict(fields, expectedFileIdentity='0:0')
        self.assertFalse(self.call('restore', path='file', **tampered)['ok'])
        self.assertFalse(self.call('restore', path='file', **dict(fields, recoveryId='../file-recovery'))['ok'])
        self.assertTrue(self.call('restore', path='file', **fields)['ok'])
        self.assertEqual(target.read_bytes(), b'preserve-file')
        self.assertFalse((self.recovery / 'file-recovery').exists())

    def test_directory_junction_descendant_and_swapped_identity_are_denied(self):
        tree = self.root / 'tree'
        tree.mkdir()
        outside = self.base / 'outside'
        outside.mkdir()
        (outside / 'sentinel').write_bytes(b'outside')
        snapshot = self.call('treeStat', path='tree')
        tree.rename(self.root / 'original')
        tree.mkdir()
        fields = dict(expectedKind='directory', expectedVersion=snapshot['version'],
                      expectedFileIdentity=snapshot['identity'])
        self.assertFalse(self.call('move', path='tree', destination='moved', **fields)['ok'])
        junction = tree / 'junction'
        made = subprocess.run(['cmd.exe', '/d', '/c', 'mklink', '/J', str(junction), str(outside)], capture_output=True)
        self.assertEqual(made.returncode, 0)
        try:
            self.assertFalse(self.call('treeStat', path='tree')['ok'])
            fields['expectedFileIdentity'] = self.call('stat', path='tree')['identity']
            self.assertFalse(self.call('move', path='tree', destination='moved', **fields)['ok'])
        finally:
            junction.rmdir()
        self.assertEqual((outside / 'sentinel').read_bytes(), b'outside')

    def test_recovery_requires_hidden_protected_private_vault(self):
        (self.root / 'file').write_bytes(b'fixture')
        fields = dict(expectedKind='file', expectedBase64=base64.b64encode(b'fixture').decode('ascii'),
                      expectedFileIdentity=self.call('stat', path='file')['identity'],
                      expectedRootIdentity=self.call('stat', path='.')['identity'],
                      recoveryRoot=str(self.recovery), recoveryId='fixture',
                      expectedRecoveryRootIdentity=self.call('stat', root=str(self.recovery), protectedPaths=[], path='.')['identity'])
        self.assertFalse(self.call('trash', path='file', protectedPaths=[], **fields)['ok'])
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.SetFileAttributesW.argtypes = [ctypes.c_wchar_p, ctypes.c_ulong]
        self.assertTrue(kernel.SetFileAttributesW(str(self.recovery), 0x80))
        self.assertFalse(self.call('trash', path='file', **fields)['ok'])
        self.assertTrue(kernel.SetFileAttributesW(str(self.recovery), 2))
        public = subprocess.run(['icacls.exe', str(self.recovery), '/grant', '*S-1-1-0:(OI)(CI)R'], capture_output=True)
        self.assertEqual(public.returncode, 0)
        self.assertFalse(self.call('trash', path='file', **fields)['ok'])
        self.assertEqual((self.root / 'file').read_bytes(), b'fixture')

    def test_no_generic_exec_or_caller_selected_root_reparse(self):
        self.assertFalse(self.call("exec", executable="cmd.exe")["ok"])
        self.assertFalse(self.call("read", path="file", unknown="ignored?")["ok"])


if __name__ == "__main__":
    unittest.main()
