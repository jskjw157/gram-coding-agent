import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createWindowsFixture, marker, privateCanary, safeFailure } from './windows-escape.fixture.js';

// Record options while retaining real Node child processes, pipes and deadlines.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(actual.execFile), spawn: vi.fn(actual.spawn) };
});

beforeAll(() => {
  // A missing prerequisite is a failing run, not an empty/skip-based success.
  expect(process.platform, 'This suite requires Linux transport fixtures; Windows native is NOT_RUN.').toBe('linux');
});

describe('Windows public-boundary historical security regressions', () => {
  let fixture: ReturnType<typeof createWindowsFixture>;
  beforeEach(() => { fixture = createWindowsFixture(); });
  afterEach(() => { fixture.cleanup(); });

  it.each([
    { label: 'registered value inside OpenAI-shaped token', text: 'sk-abINNERfixtureSECRETlongTOKENsuffix0123456789', secrets: ['INNERfixtureSECRET'], nativeCalls: 1 },
    { label: 'registered value across token start', text: 'prefix sk-abcLONGfixtureTOKENsuffix0123456789', secrets: ['prefix sk-abc'], nativeCalls: 1 },
    { label: 'partially overlapping registrations', text: 'abcdefghijklmnopqrstuvwxyz0123456789', secrets: ['abcdefghijklmnopqrst', 'tuvwxyz0123456789'], nativeCalls: 1 },
    { label: 'registered Bearer selector', text: 'Authorization: Bearer opaque-fixture-private-value', secrets: ['Authorization: Bearer'], nativeCalls: 0 },
    { label: 'registered PEM header only', text: '-----BEGIN PRIVATE KEY-----\nsynthetic-body\n-----END PRIVATE KEY-----', secrets: ['-----BEGIN PRIVATE KEY-----'], nativeCalls: 1 },
  ])('refuses a secret fragment after $label is partially consumed', async ({ text, secrets, nativeCalls }) => {
    fixture.configure('powershell.exe', 'bytes', Buffer.from(text));
    await safeFailure(fixture.clipboard(secrets).readText(), 'REDACTION_FAILED', [text]);
    expect(fixture.calls()).toHaveLength(nativeCalls);
    expect(fixture.events).toEqual([{ operation: 'READ', result: 'FAILURE', characterCount: nativeCalls ? text.length : null }]);
  });

  it('still masks a complete registered value containing overlapping secrets', async () => {
    const text = 'abcdefghijklmnopqrstuvwxyz0123456789';
    fixture.configure('powershell.exe', 'bytes', Buffer.from(text));
    expect(await fixture.clipboard([text, 'abcdefghijklmnopqrst', 'tuvwxyz0123456789']).readText())
      .toEqual({ text: marker, redacted: true });
  });

  it('bounds clipboard completion after the direct child exits with inherited pipes open', async () => {
    fixture.configure('powershell.exe', 'exited-with-pipes');
    const started = performance.now();
    await safeFailure(fixture.clipboard().readText(), 'CLIPBOARD_FAILED');
    expect(performance.now() - started).toBeLessThan(7000);
    expect(fixture.calls()).toHaveLength(1);
  });

  it('rejects clipboard stderr promptly even when a descendant retains its pipes', async () => {
    fixture.configure('powershell.exe', 'stderr-with-pipes');
    const started = performance.now();
    await safeFailure(fixture.clipboard().readText(), 'CLIPBOARD_FAILED', [privateCanary]);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(fixture.calls()).toHaveLength(1);
  });
});
