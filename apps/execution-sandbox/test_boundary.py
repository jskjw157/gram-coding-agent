import os, pathlib, shutil, subprocess, tempfile, unittest
ROOT = pathlib.Path(__file__).resolve().parent
node_command = os.environ.get('GRAM_SANDBOX_NODE') or shutil.which('node')
if not node_command:
    raise RuntimeError('Node 24 must be available on the test PATH')
NODE = pathlib.Path(node_command).resolve(strict=True)
node_version = subprocess.run([str(NODE), '-p', 'process.versions.node'], check=True, capture_output=True, text=True).stdout.strip()
if node_version.split('.')[0] != '24':
    raise RuntimeError('This profile requires genuine Node 24; observed ' + node_version)
ENTRY = os.environ.get('GRAM_SANDBOX_ENTRY')

class Boundary(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='gram-native-boundary-', dir=pathlib.Path.home())
        self.root = pathlib.Path(self.temp.name)
        self.work = self.root / 'workspace'; self.work.mkdir()
        self.secret = self.root / 'controller-canary'; self.secret.write_text('synthetic-only')
    def tearDown(self): self.temp.cleanup()
    def run_node(self, source):
        args = [str(NODE), '-e', source]
        if ENTRY: args = [ENTRY, str(self.work), str(NODE.parent.parent), '--', *args]
        return subprocess.run(args, cwd=self.work, text=True, capture_output=True, env={**os.environ, 'OPENSSL_CONF':'/dev/null'})
    def test_controller_file_denied(self):
        r = self.run_node("require('fs').readFileSync(" + repr(str(self.secret)) + ")")
        self.assertEqual(r.returncode, 1, r.stderr); self.assertIn('EACCES',r.stderr)
    def test_tmp_controller_canary_denied(self):
        with tempfile.TemporaryDirectory(prefix='gram-secret-boundary-run-') as directory:
            canary=pathlib.Path(directory)/'canary'; canary.write_text('synthetic-only')
            r=self.run_node("require('fs').readFileSync("+repr(str(canary))+")")
            self.assertEqual(r.returncode,1,r.stderr); self.assertIn('EACCES',r.stderr)
    def test_symlink_cannot_grant_controller_read(self):
        (self.work/'link').symlink_to(self.secret)
        r=self.run_node("require('fs').readFileSync('link')")
        self.assertEqual(r.returncode,1,r.stderr); self.assertIn('EACCES',r.stderr)
    def test_descendant_inherits_file_denial(self):
        source="require('fs').readFileSync(" + repr(str(self.secret)) + ")"
        import json
        r=self.run_node("const c=require('child_process').spawnSync(process.execPath,['-e',"+json.dumps(source)+"]);process.exit(c.status===1&&c.stderr.toString().includes('EACCES')?0:9)")
        self.assertEqual(r.returncode,0,r.stderr)
    def test_workspace_write_and_child_node(self):
        r = self.run_node("require('fs').writeFileSync('result','ok');require('child_process').execFileSync(process.execPath,['-e','process.exit(0)'])")
        self.assertEqual(r.returncode, 0, r.stderr); self.assertEqual((self.work/'result').read_text(),'ok')
    def test_bash_npm_lifecycle(self):
        import json
        (self.work/'package.json').write_text(json.dumps({'scripts':{'test':'node -e \"process.exit(0)\"'}}))
        args=['/usr/bin/bash','--noprofile','--norc','-c','npm run test']
        if ENTRY: args=[ENTRY,str(self.work),str(NODE.parent.parent),'--',*args]
        r=subprocess.run(args,cwd=self.work,capture_output=True,text=True,env={**os.environ,'OPENSSL_CONF':'/dev/null','PATH':str(NODE.parent)+':/usr/bin:/bin'})
        self.assertEqual(r.returncode,0,r.stderr)
    def test_network_socket_denied(self):
        r = self.run_node("const s=require('net').createServer();s.on('error',()=>process.exit(23));s.listen(0,'127.0.0.1',()=>{s.close();process.exit(0)})")
        self.assertEqual(r.returncode, 23, r.stderr)
    def test_workspace_binary_denied(self):
        import shutil
        shutil.copyfile('/usr/bin/true', self.work/'payload'); (self.work/'payload').chmod(0o700)
        r = self.run_node("require('child_process').execFileSync('./payload')")
        self.assertEqual(r.returncode, 1, r.stderr); self.assertIn('EACCES',r.stderr)

class SyscallBoundary(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='gram-native-probe-', dir=pathlib.Path.home())
        cls.root = pathlib.Path(cls.temp.name)
        cls.runtime = cls.root/'runtime'; cls.runtime.mkdir()
        cls.work = cls.root/'work'; cls.work.mkdir()
        cls.probe = cls.runtime/'probe'
        subprocess.run(['cc','-Wall','-Wextra','-Werror',str(ROOT/'probe.c'),'-o',str(cls.probe)],check=True)
    @classmethod
    def tearDownClass(cls): cls.temp.cleanup()
    def probe_result(self, operation, pass_fds=()):
        args=[str(self.probe),operation]
        if ENTRY: args=[ENTRY,str(self.work),str(self.runtime),'--',*args]
        return subprocess.run(args,capture_output=True,text=True,pass_fds=pass_fds)
    def test_dangerous_syscalls_denied(self):
        for name in ['socket','vsock','unshare','clone_namespace','ptrace','process_vm','pidfd_getfd','bpf','keyring','perf','io_uring','mount','setns','execveat','unknown','prctl_dumpable']:
            with self.subTest(name=name):
                self.assertEqual(self.probe_result(name).returncode,0,name)
    def test_clone3_reports_enosys(self): self.assertEqual(self.probe_result('clone3').returncode,0)
    def test_unix_socketpair_allowed(self): self.assertEqual(self.probe_result('socketpair').returncode,0)
    def test_x32_rejected(self): self.assertEqual(self.probe_result('x32').returncode,-31)
    def test_inherited_descriptor_closed(self):
        with open(self.root/'inherited','w') as handle:
            self.assertEqual(self.probe_result('fd:'+str(handle.fileno()),(handle.fileno(),)).returncode,0)

if __name__ == '__main__': unittest.main()
