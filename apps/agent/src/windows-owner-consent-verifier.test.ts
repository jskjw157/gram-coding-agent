import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWindowsOwnerConsentVerifier, createWindowsProtectedLocalViewer } from './windows-owner-consent-verifier.js';
import type { NativeOwnerChallenge } from './local-owner-consent.js';
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
const now = 1_800_000_000_000;
const sid = 'S-1-5-21-100-200-300-1001';
const challenge: NativeOwnerChallenge = { challengeId: 'b6389f58-14fa-4494-bf46-d137b05053c8', bindingDigest: 'a'.repeat(64), issuedAt: now - 5, expiresAt: now + 1000, target: { action: 'protected-reveal', rootId: 'owner', path: 'fixture.env', destination: null } };
let directory: string;
let helperPath: string;
let reply: (input: Record<string, unknown>) => string;
let held = false;
let diagnostic = '';
let finish: (() => void) | undefined;
function options() { return { helperPath, helperSha256: createHash('sha256').update('fixture').digest('hex'), expectedOwnerSid: sid, now: () => now }; }
function proof(input: Record<string, unknown>) { return JSON.stringify({ status: 'VERIFIED', challengeId: input.challengeId, bindingDigest: input.bindingDigest, ownerId: sid, verifiedAt: now }); }
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'gram-consent-')); helperPath = join(directory, 'consent.exe'); writeFileSync(helperPath, 'fixture'); held = false; diagnostic = ''; reply = proof; finish = undefined;
  mocks.spawn.mockReset().mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 123, kill: vi.fn() });
    let input = '';child.stdin.on('data', chunk => { input += String(chunk); });
    child.stdin.on('finish', () => { finish = () => { if (diagnostic) child.stderr.write(diagnostic);child.stdout.write(reply(JSON.parse(input) as Record<string, unknown>)); child.emit('close', 0); }; if (!held) queueMicrotask(finish); });
    return child;
  });
});
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });
describe('mocked native protocol only (does not prove Windows Hello)', () => {
  it('accepts exact native proof and sends no shell arguments', async () => {
    const verify = createWindowsOwnerConsentVerifier(options());
    expect(await verify(challenge)).toEqual({ status: 'VERIFIED', challengeId: challenge.challengeId, bindingDigest: challenge.bindingDigest, ownerId: sid, verifiedAt: now });
    expect(mocks.spawn.mock.calls[0]?.[1]).toEqual([]);
    expect(mocks.spawn.mock.calls[0]?.[2]).toMatchObject({ shell: false, env: {} });
  });
  it.each(['challengeId', 'bindingDigest', 'ownerId', 'verifiedAt', 'extra'])('denies mismatched %s without forwarding native data', async field => {
    reply = input => JSON.stringify({ ...JSON.parse(proof(input)), [field]: field === 'verifiedAt' ? now + 1 : 'secret-fixture' });
    expect(await createWindowsOwnerConsentVerifier(options())(challenge)).toEqual({ status: 'DENIED' });
  });
  it('rejects duplicate keys and trailing native output', async () => {
    reply = input => proof(input).replace('"status":"VERIFIED"', '"status":"DENIED","status":"VERIFIED"');
    expect(await createWindowsOwnerConsentVerifier(options())(challenge)).toEqual({ status: 'DENIED' });
    reply = input => proof(input) + '\nsecret-fixture';
    expect(await createWindowsOwnerConsentVerifier(options())(challenge)).toEqual({ status: 'DENIED' });
  });
  it('denies invalid lifetime and stale proof', async () => {
    const verify = createWindowsOwnerConsentVerifier(options());
    expect(await verify({ ...challenge, expiresAt: now })).toEqual({ status: 'DENIED' });
    expect(mocks.spawn).not.toHaveBeenCalled();
    reply = input => proof(input).replace(String(now), String(now - 100));
    expect(await verify(challenge)).toEqual({ status: 'DENIED' });
  });
  it('rechecks pinned helper bytes on every request', async () => {
    const verify = createWindowsOwnerConsentVerifier(options());writeFileSync(helperPath, 'replacement');
    expect(await verify(challenge)).toEqual({ status: 'DENIED' });expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it('denies native diagnostic and oversized output without forwarding it', async () => {
    diagnostic = 'fixture-secret';
    expect(await createWindowsOwnerConsentVerifier(options())(challenge)).toEqual({ status: 'DENIED' });
    diagnostic = '';reply = () => 'fixture-secret'.repeat(1000);
    expect(await createWindowsOwnerConsentVerifier(options())(challenge)).toEqual({ status: 'DENIED' });
  });
  it('rejects synthetic approval fields and invalid nonce before launching', async () => {
    const verify = createWindowsOwnerConsentVerifier(options());
    expect(await verify({ ...challenge, challengeId: 'remote-approved' })).toEqual({ status: 'DENIED' });
    expect(await verify({ ...challenge, status: 'VERIFIED' } as NativeOwnerChallenge)).toEqual({ status: 'DENIED' });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it('preserves unavailability as a fail-closed result', async () => {
    reply = () => '{"status":"UNAVAILABLE"}';
    expect(await createWindowsOwnerConsentVerifier(options())(challenge)).toEqual({ status: 'UNAVAILABLE' });
  });
  it('allows one active native prompt across instances', async () => {
    held = true;const first = createWindowsOwnerConsentVerifier(options())(challenge);
    expect(await createWindowsOwnerConsentVerifier(options())(challenge)).toEqual({ status: 'DENIED' });
    await new Promise(resolve => setImmediate(resolve));finish?.();await first;
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });
  it('viewer sends exact bytes privately and returns status only', async () => {
    const content = Buffer.from('fixture-secret=value');
    reply = input => { expect(input.contentBase64).toBe(content.toString('base64'));expect(input.bindingDigest).toBe(createHash('sha256').update(content).digest('hex'));return '{"status":"DISPLAYED"}'; };
    expect(await createWindowsProtectedLocalViewer(options()).show({ target: challenge.target, content })).toEqual({ status: 'DISPLAYED' });
  });
  it('viewer denies non-UTF8, oversized, and mismatched operations', async () => {
    const viewer = createWindowsProtectedLocalViewer(options());
    for (const content of [Buffer.from([255]), Buffer.alloc(256 * 1024 + 1)]) expect(await viewer.show({ target: challenge.target, content })).toEqual({ status: 'DENIED' });
    expect(await viewer.show({ target: { ...challenge.target, action: 'destructive' }, content: Buffer.from('fixture') })).toEqual({ status: 'DENIED' });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it('viewer rejects VERIFIED responses and any content-bearing receipt', async () => {
    const viewer = createWindowsProtectedLocalViewer(options());
    expect(await viewer.show({ target: challenge.target, content: Buffer.from('fixture') })).toEqual({ status: 'DENIED' });
    reply = () => '{"status":"DISPLAYED","content":"fixture-secret"}';
    expect(await viewer.show({ target: challenge.target, content: Buffer.from('fixture') })).toEqual({ status: 'DENIED' });
  });
});
