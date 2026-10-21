import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { LinuxIsolatedProcessSpawner } from '@gram/shell';

// This mandatory target gate is executed separately on real WSL2, not skipped
// into a successful generic Linux job. Both Windows-side files are synthetic.
it('blocks a copied Windows image after proving the identical outside Windows route works', async () => {
  expect(readFileSync('/proc/sys/kernel/osrelease', 'utf8').toLowerCase()).toContain('microsoft');
  const evidence = mkdtempSync('/mnt/c/source/gram-agent-diagnostics/m5-wsl-canary-');
  const windows = 'C:\\source\\gram-agent-diagnostics\\' + evidence.split('/').at(-1);
  const outside = join(evidence, 'outside-positive.txt'), inside = join(evidence, 'inside-forbidden.txt');
  const command = '/mnt/c/Windows/System32/cmd.exe';
  execFileSync(command, ['/d', '/c', `echo outside-positive>${windows}\\outside-positive.txt`],
    { cwd: '/mnt/c/source', stdio: 'pipe', timeout: 10_000 });
  expect(readFileSync(outside, 'utf8').trim()).toBe('outside-positive');
  const root = mkdtempSync('/tmp/gram-wsl-profile-'); const workspace = join(root, 'workspace'); mkdirSync(workspace);
  copyFileSync(command, join(workspace, 'copied-cmd.exe'));
  const spawner = new LinuxIsolatedProcessSpawner({ workspaceForTask: () => ({ workspace, identity: 'wsl-lab-v1' }) });
  const args = ['/d', '/c', `echo forbidden>${windows}\\inside-forbidden.txt`];
  const script = `try{require('child_process').execFileSync('./copied-cmd.exe',${JSON.stringify(args)});process.exit(8)}catch(e){console.log(e.code);process.exit(e.code==='EACCES'?0:9)}`;
  const result = await spawner.spawn({ taskId: 'wsl-canary', cwd: workspace, category: 'VERIFICATION',
    executable: process.execPath, args: ['-e', script], env: {} });
  expect(result.exitCode, result.stderr).toBe(0); expect(result.stdout.trim()).toBe('EACCES');
  expect(existsSync(inside)).toBe(false);
  writeFileSync(join(evidence, 'observation.json'), JSON.stringify({
    measuredAt: new Date().toISOString(), profile: 'linux-node-v1', workspace,
    outsideWindowsPositive: true, insideWindowsFileAbsent: true, copiedImageExecErrno: result.stdout.trim(),
  }, null, 2) + '\n');
  // Retain these exact new fixtures and the outside observer receipt as evidence.
});
