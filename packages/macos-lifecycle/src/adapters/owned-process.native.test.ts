import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMacConnectedPeerVerifier, createNativePeerProof, sealMacOwnedChild } from './owned-process.js';

const exec = promisify(execFile);
const digest = 'a'.repeat(64);
const children: ChildProcess[] = [];
let dir = ''; let helper = '';

function message(child: ChildProcess, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('fixture timeout')); }, 5000);
    const onExit = () => { cleanup(); reject(new Error('fixture exited')); };
    const onMessage = (value: unknown) => {
      if (value !== null && typeof value === 'object' && (value as Record<string, unknown>).type === type) {
        cleanup(); resolve(value as Record<string, unknown>);
      }
    };
    const cleanup = () => {
      clearTimeout(timer); child.off('exit', onExit); child.off('message', onMessage);
    };
    child.once('exit', onExit); child.on('message', onMessage);
  });
}
async function server(): Promise<{ child: ChildProcess; port: number }> {
  const script = [
    "const net=require('node:net');",
    "const s=net.createServer(c=>{process.send?.({type:'accepted',localPort:c.localPort,remotePort:c.remotePort});c.on('data',()=>{});});",
    "s.listen({host:'127.0.0.1',port:0},()=>process.send?.({type:'listening',port:s.address().port}));",
    "process.on('message',m=>{if(m==='stop')s.close(()=>process.exit(0));});",
  ].join('');
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  children.push(child);
  const started = await message(child, 'listening'); const port = started.port;
  if (typeof port !== 'number') throw new Error('fixture port');
  return { child, port };
}
function connect(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('error', reject);
    socket.once('connect', () => { socket.off('error', reject); socket.pause(); resolve(socket); });
  });
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.send?.('stop');
  await Promise.race([exited, new Promise<void>(resolve => setTimeout(resolve, 1000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
function uid(): number {
  const value = process.getuid?.();
  if (typeof value !== 'number') throw new Error('uid unavailable');
  return value;
}

describe.skipIf(process.platform !== 'darwin')('native accepted-peer proof (temporary fixtures only)', () => {
  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'gram peer owner ')));
    helper = join(dir, 'peer-owner');
    await exec('/usr/bin/xcrun', ['clang', '-std=c11', '-Wall', '-Wextra', '-Werror',
      fileURLToPath(new URL('../../../../platform/macos/native/peer-owner.c', import.meta.url)), '-o', helper]);
  }, 30000);
  afterAll(async () => {
    for (const child of children) await stop(child);
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('binds a real child start identity and proves its accepted loopback socket', async () => {
    const fixture = await server(); const executable = await stat(process.execPath, { bigint: true });
    const proof = createNativePeerProof(helper);
    const seal = await sealMacOwnedChild(fixture.child, {
      role: 'core', uid: uid(), generation: 'native-1', releaseDigest: digest,
      executable: { dev: executable.dev, ino: executable.ino },
    }, proof, new AbortController().signal);
    expect(seal).not.toBeNull();
    if (seal === null) throw new Error('native seal');

    const accepted = message(fixture.child, 'accepted');
    const socket = await connect(fixture.port);
    try {
      const seen = await accepted;
      expect(seen.localPort).toBe(fixture.port);
      expect(seen.remotePort).toBe(socket.localPort);
      expect(await createMacConnectedPeerVerifier(seal, proof)
        .verify(socket, seal.child, new AbortController().signal)).toBe('OWNED');
    } finally { socket.destroy(); }
  });

  it('returns non-OWNED for a different accepted server and for executable mismatch', async () => {
    const expected = await server(); const foreign = await server();
    const executable = await stat(process.execPath, { bigint: true }); const proof = createNativePeerProof(helper);
    const seal = await sealMacOwnedChild(expected.child, {
      role: 'core', uid: uid(), generation: 'native-2', releaseDigest: digest,
      executable: { dev: executable.dev, ino: executable.ino },
    }, proof, new AbortController().signal);
    expect(seal).not.toBeNull();
    if (seal === null) throw new Error('native seal');

    const accepted = message(foreign.child, 'accepted'); const socket = await connect(foreign.port);
    try {
      await accepted;
      expect(await createMacConnectedPeerVerifier(seal, proof)
        .verify(socket, seal.child, new AbortController().signal)).not.toBe('OWNED');
    } finally { socket.destroy(); }

    expect(await sealMacOwnedChild(expected.child, {
      role: 'core', uid: uid(), generation: 'native-3', releaseDigest: digest,
      executable: { dev: executable.dev, ino: executable.ino + 1n },
    }, proof, new AbortController().signal)).toBeNull();
  });

  it('invalidates the seal after the recorded process exits', async () => {
    const fixture = await server(); const executable = await stat(process.execPath, { bigint: true });
    const proof = createNativePeerProof(helper);
    const seal = await sealMacOwnedChild(fixture.child, {
      role: 'core', uid: uid(), generation: 'native-4', releaseDigest: digest,
      executable: { dev: executable.dev, ino: executable.ino },
    }, proof, new AbortController().signal);
    expect(seal).not.toBeNull();
    if (seal === null) throw new Error('native seal');
    await stop(fixture.child);
    expect(await createMacConnectedPeerVerifier(seal, proof).current(seal.child)).toBe(false);
  });
});
