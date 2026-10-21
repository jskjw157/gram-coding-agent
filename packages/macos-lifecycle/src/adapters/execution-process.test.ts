import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { createExecutionFilesAt } from './execution-files.js';
import { ExecutionLeaseStore } from '../execution-lease.js';
import { configDigest, releaseDigest } from '../test-support/execution-fixture.js';

it('honors the fixed transaction lock held by a separate process without stealing it', async () => {
  const anchor = await realpath(await mkdtemp(join(tmpdir(), 'gram-execution-process-')));
  await chmod(anchor, 0o700); await mkdir(join(anchor, 'run'), { mode: 0o700 });
  const uid = process.getuid?.() ?? 0;
  const store = new ExecutionLeaseStore(createExecutionFilesAt({ anchor, relative: 'run', ancestorUid: uid,
    stateUid: uid, acl: async () => true }));
  await store.initializeNew('core');
  const path = join(anchor, 'run/core.execution.lock');
  const script = "const f=require('node:fs');const fd=f.openSync(process.argv[1],'wx',0o600);f.writeSync(fd,'fixture-owner');process.send({ready:true});process.on('message',()=>{f.closeSync(fd);process.exit(0);});";
  const child = spawn(process.execPath, ['-e', script, path], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('fixture startup timeout')); }, 3000);
      const error = () => { cleanup(); reject(new Error('fixture failed')); };
      const ready = (value: unknown) => {
        if (value !== null && typeof value === 'object' && (value as { ready?: boolean }).ready === true) {
          cleanup(); resolve();
        }
      };
      const cleanup = () => { clearTimeout(timer); child.off('message', ready); child.off('error', error); child.off('exit', error); };
      child.on('message', ready); child.once('error', error); child.once('exit', error);
    });
    await expect(store.acquire('core', 'g1', configDigest, releaseDigest)).rejects.toThrow('BUSY');
    expect(await readFile(path, 'utf8')).toBe('fixture-owner');
    expect((await store.read('core')).state).toBe('FREE');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited; await rm(anchor, { recursive: true, force: true });
  }
}, 10000);
