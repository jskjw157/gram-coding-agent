import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import json
import os
import subprocess
import urllib.request
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('installer', Path(__file__).with_name('stage-sandbox-node.py'))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


def archive(name='package/bin/pnpm.cjs', data=b'#!/usr/bin/env node\n', kind=None, link=''):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as tar:
        info = tarfile.TarInfo(name)
        info.mode = 0o7777
        if kind is not None:
            info.type = kind
            info.linkname = link
        else:
            info.size = len(data)
        tar.addfile(info, io.BytesIO(data) if kind is None else None)
    return output.getvalue()


class InstallerTests(unittest.TestCase):
    def test_hash_mismatch(self):
        with self.assertRaisesRegex(ValueError, 'digest'):
            installer.verify_bytes(b'wrong', 'sha256', '0' * 64)

    def test_reject_escaping_paths(self):
        for name in ['/package/file', 'package/../file', 'package/./file', 'package/a\\file']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                installer.curate(archive(name), 'pnpm')

    def test_reject_links_and_specials(self):
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE, tarfile.CHRTYPE]:
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                installer.curate(archive(kind=kind, link='/etc/passwd'), 'pnpm')

    def test_normalize_modes_and_reject_native(self):
        tree = installer.curate(archive(), 'pnpm')
        self.assertEqual(tree['lib/node_modules/pnpm/bin/pnpm.cjs'][1], 0o755)
        for data in [b'\x7fELFpayload', b'MZpayload']:
            with self.assertRaises(ValueError):
                installer.curate(archive(data=data), 'pnpm')

    def test_no_clobber(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'source').mkdir()
            (root / 'target').mkdir()
            (root / 'target/evidence').write_text('preserved')
            with self.assertRaises(FileExistsError):
                installer.publish(root / 'source', root / 'target')
            self.assertEqual((root / 'target/evidence').read_text(), 'preserved')

    def test_reject_duplicate_members_and_file_directory_conflicts(self):
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode='w:gz') as tar:
            for _ in range(2):
                info = tarfile.TarInfo('package/bin/pnpm.cjs')
                info.size = 1
                tar.addfile(info, io.BytesIO(b'x'))
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            installer.curate(output.getvalue(), 'pnpm')

    def test_member_size_limit_precedes_read(self):
        info = tarfile.TarInfo('package/large')
        info.size = installer.MAX_FILE + 1
        with self.assertRaisesRegex(ValueError, 'byte limit'):
            installer.curate(info.tobuf() + bytes(1024), 'pnpm')

    def test_no_clobber_preserves_symlink_destination(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'source').mkdir()
            (root / 'destination').symlink_to('absent')
            with self.assertRaises(FileExistsError):
                installer.publish(root / 'source', root / 'destination')
            self.assertTrue((root / 'destination').is_symlink())

    def test_golden_manifest_agrees_with_typescript_constants(self):
        tree = {'bin': ('d', 0o755, ''), 'bin/node': ('f', 0o755, b'abc'),
                'bin/npm': ('l', 0o777, '../lib/node_modules/npm/bin/npm-cli.js')}
        serialized = json.dumps(installer.manifest(tree), separators=(',', ':'))
        contract = (Path(__file__).parents[1] / 'packages/shell/src/sandbox-runtime-contract.ts').read_text()
        literal = contract.split('SANDBOX_RUNTIME_MANIFEST_GOLDEN = ', 1)[1].split(';', 1)[0]
        expected = json.loads(literal)
        self.assertEqual(serialized, expected)
        self.assertIn(hashlib.sha256(serialized.encode()).hexdigest(), contract)

    def test_verified_official_archives_materialize_exact_contract(self):
        blobs = []
        for kind, filename in [('node', 'node.tar.xz'), ('pnpm', 'pnpm.tgz')]:
            local = os.environ.get('GRAM_TEST_OFFICIAL_ARCHIVES')
            if local:
                data = (Path(local) / filename).read_bytes()
            else:
                with urllib.request.urlopen(installer.ARTIFACTS[kind][0], timeout=60) as response:
                    data = response.read(installer.MAX_ARCHIVE + 1)
            blobs.append(data)
        tree = installer.assemble(*blobs)
        self.assertEqual(len(tree), installer.EXPECTED_FILE_COUNT)
        self.assertEqual(installer.tree_digest(tree), installer.EXPECTED_TREE_SHA256)
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / 'runtime'
            destination.mkdir()
            previous_umask = os.umask(0o077)
            try:
                installer.materialize(tree, destination)
            finally:
                os.umask(previous_umask)
            self.assertEqual(installer.manifest(installer.scan(destination)), installer.manifest(tree))
            self.assertEqual(subprocess.check_output([destination / 'bin/node', '--version'], text=True).strip(), 'v24.21.0')
            environment = {'PATH': str(destination / 'bin') + ':/usr/bin:/bin', 'HOME': temporary}
            self.assertEqual(subprocess.check_output([destination / 'bin/pnpm', '--version'], env=environment, text=True).strip(), '10.34.5')
            self.assertTrue(subprocess.check_output([destination / 'bin/npm', '--version'], env=environment, text=True).strip())


if __name__ == '__main__':
    unittest.main()
