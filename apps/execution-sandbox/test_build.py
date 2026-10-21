import os, pathlib, re, subprocess, tempfile, unittest
ROOT=pathlib.Path(__file__).resolve().parent
class Build(unittest.TestCase):
    def test_new_private_executable_is_published(self):
        with tempfile.TemporaryDirectory() as directory:
            output=pathlib.Path(directory)/'entry'
            result=subprocess.run(['sh',str(ROOT/'build.sh'),str(output)],capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(output.stat().st_mode & 0o777,0o700)
            self.assertEqual(subprocess.run([str(output)],capture_output=True).returncode,125)
            self.assertEqual(list(pathlib.Path(directory).glob('*.build.*')),[])
    def test_existing_output_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            output=pathlib.Path(directory)/'entry'; output.write_text('existing-artifact')
            result=subprocess.run(['sh',str(ROOT/'build.sh'),str(output)],capture_output=True,text=True)
            self.assertNotEqual(result.returncode,0)
            self.assertEqual(output.read_text(),'existing-artifact')
    def test_older_uapi_headers_compile_full_abi7_contract(self):
        # Compile-time compatibility only: execution tests always use the real kernel.
        with tempfile.TemporaryDirectory() as directory:
            folder=pathlib.Path(directory); include=folder/'linux'; include.mkdir()
            header=pathlib.Path('/usr/include/linux/landlock.h').read_text()
            header=re.sub(r'__u64 scoped;', '', header)
            header=re.sub(r'^#define LANDLOCK_(?:SCOPE_\w+|ACCESS_FS_IOCTL_DEV)[^\n]*', '', header, flags=re.M)
            (include/'landlock.h').write_text(header)
            result=subprocess.run(['cc','-std=c11','-Wall','-Wextra','-Werror','-I'+str(folder),str(ROOT/'entry.c'),'-o',str(folder/'entry')],capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
if __name__=='__main__':unittest.main()
