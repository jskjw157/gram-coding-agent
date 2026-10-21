"""Real Windows fixture tests. Invoke with the fixed helper executable path.

These exercise native filesystem effects, not mocked authorization or production
state. The helper is not deployed by this test.
"""
import base64
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

HELPER = pathlib.Path(sys.argv.pop(1)).resolve() if len(sys.argv) > 1 else None


class WindowsWorkspace(unittest.TestCase):
    def setUp(self):
        self.fixture = tempfile.TemporaryDirectory(prefix="gram-native-workspace-")
        self.base = pathlib.Path(self.fixture.name)
        self.root = self.base / "root"
        self.root.mkdir()
        self.recovery = self.base / "private-recovery"
        self.recovery.mkdir()

    def tearDown(self):
        self.fixture.cleanup()

    def call(self, operation, **fields):
        request = {"operation": operation, "root": str(self.root), "path": ".",
                   "protectedPaths": [str(self.recovery)], **fields}
        result = subprocess.run([str(HELPER)], input=json.dumps(request), text=True,
                                capture_output=True, timeout=10, check=False)
        self.assertLess(len(result.stdout), 1500000)
        return json.loads(result.stdout)

    def test_real_hidden_binary_read_and_list(self):
        (self.root / ".env").write_bytes(b"SAFE=enabled\n")
        binary = b"\x00\x01\xff\x89PNG"
        (self.root / "image.bin").write_bytes(binary)
        self.assertEqual({item["name"] for item in self.call("list")["entries"]}, {".env", "image.bin"})
        self.assertEqual(base64.b64decode(self.call("read", path="image.bin")["base64"]), binary)

    def test_atomic_expected_preimage_write_and_permissions(self):
        target = self.root / "existing.txt"
        target.write_bytes(b"original")
        encoded = lambda value: base64.b64encode(value).decode("ascii")
        conflict = self.call("write", path="existing.txt", expectedBase64=encoded(b"wrong"), base64=encoded(b"new"))
        self.assertFalse(conflict["ok"])
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

    def test_no_generic_exec_or_caller_selected_root_reparse(self):
        self.assertFalse(self.call("exec", executable="cmd.exe")["ok"])
        self.assertFalse(self.call("read", path="file", unknown="ignored?")["ok"])


if __name__ == "__main__":
    unittest.main()
