# Fixed test launcher only; never imported by the agent or used for installation.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$test = Join-Path $PSScriptRoot 'test-windows-owner-workspace-install.ps1'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    & $test
    exit 0
}

# Hosted Windows CI starts elevated. Run the same real denial tests with a
# restricted version of its own token, rather than mocking elevation or skipping.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class GramInstallerTestToken {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
        public int cb; public string reserved, desktop, title;
        public uint x,y,xsize,ysize,xchars,ychars,fill,flags;
        public ushort show,reservedSize; public IntPtr reservedBytes,input,output,error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
        public IntPtr process,thread; public uint pid,tid;
    }
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr existing,uint flags,
        uint disable,IntPtr sids,uint delete,IntPtr privileges,uint restrict,IntPtr restrictions,out IntPtr token);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessAsUser(
        IntPtr token,string app,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,
        uint flags,IntPtr environment,string cwd,ref Startup startup,out ProcessInfo process);
    public static uint RunFixedTest(string directory,string log) {
        if (directory.IndexOf('\'')>=0 || log.IndexOf('\'')>=0) throw new ArgumentException("Unsupported test path");
        string app=System.IO.Path.Combine(Environment.SystemDirectory,@"WindowsPowerShell\v1.0\powershell.exe");
        string test=System.IO.Path.Combine(directory,"test-windows-owner-workspace-install.ps1");
        IntPtr original=IntPtr.Zero, restricted=IntPtr.Zero;
        ProcessInfo child=new ProcessInfo();
        try {
            if (!OpenProcessToken(GetCurrentProcess(),0xB,out original)) throw new Win32Exception();
            // DISABLE_MAX_PRIVILEGE | LUA_TOKEN; never SANDBOX_INERT.
            if (!CreateRestrictedToken(original,0x5,0,IntPtr.Zero,0,IntPtr.Zero,0,IntPtr.Zero,out restricted)) throw new Win32Exception();
            var startup=new Startup(); startup.cb=Marshal.SizeOf(startup);
            var command=new StringBuilder("\""+app+"\" -NoProfile -NonInteractive -Command \"& '"+test+"' *> '"+log+"'; if (-not $?) { exit 1 }\"");
            if (!CreateProcessAsUser(restricted,app,command,IntPtr.Zero,IntPtr.Zero,false,0x08000000,IntPtr.Zero,directory,ref startup,out child)) throw new Win32Exception();
            if (WaitForSingleObject(child.process,120000)!=0) throw new InvalidOperationException("Test did not terminate; no retry performed");
            uint result;
            if (!GetExitCodeProcess(child.process,out result)) throw new Win32Exception();
            return result;
        } finally {
            if(child.thread!=IntPtr.Zero) CloseHandle(child.thread);
            if(child.process!=IntPtr.Zero) CloseHandle(child.process);
            if(restricted!=IntPtr.Zero) CloseHandle(restricted);
            if(original!=IntPtr.Zero) CloseHandle(original);
        }
    }
}
'@
$log = Join-Path ([IO.Path]::GetTempPath()) ('gram-installer-ci-' + [guid]::NewGuid().ToString('N') + '.log')
$code = [GramInstallerTestToken]::RunFixedTest($PSScriptRoot, $log)
if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log }
if ($code -ne 0) { throw "Restricted-token installer tests failed: $code" }
Write-Output 'PASS: actual restricted-token installer tests; no elevation or application-policy bypass'
