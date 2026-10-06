import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createConnection, type Socket } from 'node:net';
import type { OwnedChild } from '../contracts.js';
import type { CoreCredentials } from '../health-probe.js';
import { bindOwnedConnection, type ConnectedPeerVerifier } from './loopback-http.js';
const sockets: Socket[] = []; const servers: Server[] = [];
const signal = () => new AbortController().signal;
const child = (): OwnedChild => ({ role: 'core', pid: 123, uid: 501, startIdentity: 'start-1',
  generation: 'generation-1', releaseDigest: 'a'.repeat(64) });
async function fixture() {
  let bytes = 0;
  const server = createServer((_req, res) => res.end('{}')); servers.push(server);
  server.on('connection', s => { sockets.push(s); s.on('data', (b: Buffer) => { bytes += b.length; }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address(); if (!addr || typeof addr === 'string') throw new Error('fixture');
  const socket = createConnection({ host: '127.0.0.1', port: addr.port }); sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject); socket.once('connect', () => {
      socket.off('error', reject); socket.on('error', () => undefined); socket.pause(); resolve();
    });
  });
  return { socket, bytes: () => bytes };
}
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
});
it('rechecks current generation after pre-broker asynchronous peer proof', async () => {
  const f = await fixture(); let owned = true; let proofs = 0; let uses = 0;
  const verifier: ConnectedPeerVerifier = { async current() { return owned; },
    async verify() { if (++proofs === 2) owned = false; return 'OWNED'; } };
  const credentials: CoreCredentials = { async withValue(use) { uses++; return use('SYNTHETIC_LOCAL_TEST'); } };
  const connection = await bindOwnedConnection(f.socket, child(), verifier, signal());
  if (!connection) throw new Error('fixture binding');
  await expect(connection.request('initialize', credentials, undefined, signal())).rejects.toThrow(/^HEALTH_UNKNOWN$/);
  expect(uses).toBe(0); expect(f.bytes()).toBe(0);
});
it('rejects generation replacement while establishing a connection capability', async () => {
  const f = await fixture(); let owned = true;
  const verifier: ConnectedPeerVerifier = { async current() { return owned; },
    async verify() { owned = false; return 'OWNED'; } };
  const connection = await bindOwnedConnection(f.socket, child(), verifier, signal());
  connection?.close(); expect(connection).toBeNull(); expect(f.bytes()).toBe(0);
});
it('bounds a hung binding verifier without relying on a caller deadline', async () => {
  const f = await fixture(); const controller = new AbortController();
  const verifier: ConnectedPeerVerifier = { async current() { return true; },
    async verify() { return new Promise(() => undefined); } };
  const guard = setTimeout(() => controller.abort(), 3500); const begin = Date.now();
  try {
    expect(await bindOwnedConnection(f.socket, child(), verifier, controller.signal)).toBeNull();
    expect(Date.now() - begin).toBeLessThan(3000); expect(f.bytes()).toBe(0);
  } finally { clearTimeout(guard); }
}, 6000);
