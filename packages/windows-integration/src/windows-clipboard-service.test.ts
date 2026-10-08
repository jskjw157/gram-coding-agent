import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { SecretRedactor } from '../../secrets/src/redactor.js';
import * as api from './index.js';
import type {
  ClipboardAuditEvent,
  ClipboardRunner,
  WindowsClipboardOptions,
} from './windows-clipboard-service.js';

const limit = 1048576;
const marker = '***REDACTED***';
const privateValue = 'fixture-private-value.[a]+';

function fixture(
  text = '',
  secrets: readonly string[] = [],
  overrides: Partial<WindowsClipboardOptions> = {},
) {
  const events: ClipboardAuditEvent[] = [];
  const writes: Uint8Array[] = [];
  const runner: ClipboardRunner = {
    readText: vi.fn(async () => Buffer.from(text, 'utf8')),
    writeText: vi.fn(async (bytes) => { writes.push(Buffer.from(bytes)); }),
  };
  const options = {
    redactor: new SecretRedactor(secrets),
    registeredSecrets: secrets,
    audit: { record: async (event: ClipboardAuditEvent) => { events.push(event); } },
    runner,
    ...overrides,
  };
  return { service: new api.WindowsClipboardService(options), events, writes, runner, options };
}

describe('WindowsClipboardService text boundary', () => {
  it.each([
    '',
    ' \t\r\n한글 🧵 "quotes" \'single\' & $(literal); %COMSPEC% \n ',
    '\ufeffleading BOM and \ufffd literal replacement',
  ])('preserves valid text and audits counts without the body (%j)', async (text) => {
    const f = fixture(text as string);
    expect(await f.service.readText()).toEqual({ text, redacted: false });
    await expect(f.service.writeText(text as string)).resolves.toBeUndefined();
    expect(f.writes).toHaveLength(1);
    expect(Buffer.from(f.writes[0] ?? []).toString('utf8')).toBe(text);
    expect(f.events).toEqual([
      { operation: 'READ', result: 'SUCCESS', characterCount: (text as string).length },
      { operation: 'WRITE', result: 'SUCCESS', characterCount: (text as string).length },
    ]);
  });

  it.each([
    ['ASCII', 'a'.repeat(limit)],
    ['Korean', '한'.repeat(349525) + 'x'],
    ['emoji', '🧵'.repeat(262144)],
  ])('accepts exactly 1 MiB of UTF-8 %s for reads and writes', async (_label, text) => {
    const f = fixture(text);
    expect(await f.service.readText()).toEqual({ text, redacted: false });
    await f.service.writeText(text);
    expect(f.writes[0]?.byteLength).toBe(limit);
  });

  it.each([
    ['ASCII', 'a'.repeat(limit + 1)],
    ['Korean', '한'.repeat(349525) + 'xx'],
    ['emoji', '🧵'.repeat(262144) + 'x'],
  ])('rejects more than 1 MiB of UTF-8 %s without truncation or a write', async (_label, text) => {
    const f = fixture(text);
    await expect(f.service.readText()).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    await expect(f.service.writeText(text)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(f.writes).toEqual([]);
    expect(f.events.every((event) => event.result === 'FAILURE')).toBe(true);
  });

  it.each([
    null, undefined, 17, {}, ['text'], Buffer.from('text'),
    { text: 'x', command: 'calc.exe' }, 'before\0after', '\ud800', '\udc00', 'x\ud800y',
  ])('rejects invalid write input %j before dispatch', async (value) => {
    const f = fixture();
    await expect(f.service.writeText(value as string)).rejects.toMatchObject({ code: 'INVALID_TEXT' });
    expect(f.writes).toEqual([]);
    expect(f.events).toEqual([{ operation: 'WRITE', result: 'FAILURE', characterCount: null }]);
  });

  it.each([
    [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xff],
    [0xe3, 0x81], [0x61, 0xc3, 0x28], [0xff, 0xfe, 0x61, 0x00],
  ].map((bytes) => [bytes]))('rejects malformed, truncated, or non-UTF-8 process bytes %j', async (bytes) => {
    const f = fixture();
    vi.mocked(f.runner.readText).mockResolvedValue(Uint8Array.from(bytes));
    await expect(f.service.readText()).rejects.toMatchObject({ code: 'INVALID_ENCODING' });
    expect(f.events).toEqual([{ operation: 'READ', result: 'FAILURE', characterCount: null }]);
  });

  it.each([null, undefined, 'unframed raw string', {}, ['text']])(
    'rejects a non-byte runner result %j',
    async (value) => {
      const f = fixture();
      vi.mocked(f.runner.readText).mockResolvedValue(value as Uint8Array);
      await expect(f.service.readText()).rejects.toMatchObject({ code: 'INVALID_ENCODING' });
    },
  );

  it('rejects NUL in decoded clipboard data', async () => {
    await expect(fixture('before\0after').service.readText()).rejects.toMatchObject({ code: 'INVALID_TEXT' });
  });
});

describe('WindowsClipboardService reuses the existing SecretRedactor', () => {
  it('masks every registered literal, including regex syntax and overlapping values', async () => {
    const f = fixture('before ' + privateValue + ' other-secret longer-other-secret after',
      [privateValue, 'other-secret', 'longer-other-secret']);
    expect(await f.service.readText()).toEqual({
      text: 'before ' + marker + ' ' + marker + ' ' + marker + ' after',
      redacted: true,
    });
    expect(JSON.stringify(f.events)).not.toContain(privateValue);
  });

  it.each([
    'sk-' + 'fixture_01234567890',
    'github_pat_' + 'fixture_01234567890',
    ...['o', 'p', 'u', 's', 'r'].map((kind) => 'gh' + kind + '_' + 'fixture01234567890'),
  ])('masks a token recognized by the existing redactor', async (token) => {
    expect(await fixture('before ' + token + ' after').service.readText()).toEqual({
      text: 'before ' + marker + ' after', redacted: true,
    });
  });

  it('masks a case-insensitive Authorization Bearer value', async () => {
    expect(await fixture('aUtHoRiZaTiOn:\tBEARER fixture-private-bearer').service.readText()).toEqual({
      text: 'aUtHoRiZaTiOn:\tBEARER ' + marker, redacted: true,
    });
  });

  it('keeps written secrets as clipboard data while returning void and auditing no content', async () => {
    const f = fixture('', [privateValue]);
    await expect(f.service.writeText(privateValue)).resolves.toBeUndefined();
    expect(Buffer.from(f.writes[0] ?? []).toString()).toBe(privateValue);
    expect(f.events).toEqual([{ operation: 'WRITE', result: 'SUCCESS', characterCount: privateValue.length }]);
    expect(inspect(f.service)).not.toContain(privateValue);
  });

  it('snapshots the complete registration list instead of trusting later caller mutation', async () => {
    const secrets = [privateValue];
    const f = fixture(privateValue, secrets, { redactor: { redact: (text) => text } });
    secrets.length = 0;
    await expect(f.service.readText()).rejects.toMatchObject({ code: 'REDACTION_FAILED' });
    expect(f.runner.readText).not.toHaveBeenCalled();
  });

  it.each([
    undefined, null, {}, { redact: 1 }, { redact: (text: string) => text },
    { redact: () => { throw new Error(privateValue); } },
    { redact: async () => marker }, { redact: () => 17 },
  ])('fails before clipboard acquisition when the redactor is unusable', async (redactor) => {
    const f = fixture(privateValue, [privateValue], { redactor: redactor as WindowsClipboardOptions['redactor'] });
    const error = await f.service.readText().catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: 'REDACTION_FAILED' });
    expect(f.runner.readText).not.toHaveBeenCalled();
    expect(inspect(error)).not.toContain(privateValue);
  });

  it.each([undefined, null, 'not-an-array', [''], ['\ud800'], ['contains\0nul']])(
    'fails before acquisition when the secret registration snapshot is invalid',
    async (registeredSecrets) => {
      const f = fixture(privateValue, [], { registeredSecrets: registeredSecrets as readonly string[] });
      await expect(f.service.readText()).rejects.toMatchObject({ code: 'REDACTION_FAILED' });
      expect(f.runner.readText).not.toHaveBeenCalled();
    },
  );

  it.each(['*', 'R', 'REDACTED', marker])(
    'refuses registration that conflicts with the replacement marker',
    async (secret) => {
      const f = fixture('some ' + secret, [secret]);
      await expect(f.service.readText()).rejects.toMatchObject({ code: 'REDACTION_FAILED' });
      expect(f.runner.readText).not.toHaveBeenCalled();
    },
  );

  it('rechecks the actual response for a registered value missed by a selective redactor', async () => {
    const source = 'only fail on this ' + privateValue;
    const real = new SecretRedactor([privateValue]);
    const f = fixture(source, [privateValue], {
      redactor: { redact: (text) => text === source ? text : real.redact(text) },
    });
    await expect(f.service.readText()).rejects.toMatchObject({ code: 'REDACTION_FAILED' });
  });

  it.each([
    'prefixsk-' + 'fixture01234567890',
    'xoxb-' + '1234567890-1234567890-fixtureabcdefghijkl',
    'AKIA' + 'ABCDEFGHIJKLMNOP',
    'eyJhbGciOiJIUzI1NiJ9' + '.eyJzdWIiOiJmaXh0dXJlIn0' + '.abcdefghijklmno',
    '-----BEGIN ' + 'PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----',
  ])('refuses recognizable credential shapes that the configured redactor leaves behind', async (text) => {
    await expect(fixture(text).service.readText()).rejects.toMatchObject({ code: 'REDACTION_FAILED' });
  });

  it.each([17, null, Promise.resolve(marker), '\ud800', 'a\0b', 'x'.repeat(limit + 1)])(
    'rejects an invalid actual redaction result after successful probes',
    async (result) => {
      const real = new SecretRedactor();
      const f = fixture('fixture source', [], {
        redactor: { redact: (text) => text === 'fixture source' ? result as string : real.redact(text) },
      });
      await expect(f.service.readText()).rejects.toMatchObject({ code: 'REDACTION_FAILED' });
    },
  );

  it('rejects non-idempotent redaction instead of returning an unverified first pass', async () => {
    const real = new SecretRedactor();
    const f = fixture('fixture source', [], {
      redactor: { redact: (text) => text === 'fixture source' || text === 'unstable'
        ? text === 'fixture source' ? 'unstable' : 'changed' : real.redact(text) },
    });
    await expect(f.service.readText()).rejects.toMatchObject({ code: 'REDACTION_FAILED' });
  });

  it('rejects redaction expansion beyond 1 MiB without truncating or leaking raw data', async () => {
    const f = fixture('q'.repeat(90000), ['q']);
    await expect(f.service.readText()).rejects.toMatchObject({ code: 'REDACTION_FAILED' });
  });

  it.each(['configuration', 'response'])(
    'contains rejected asynchronous redactor promises during %s validation',
    async (phase) => {
      const unhandled: unknown[] = [];
      const observe = (reason: unknown) => { unhandled.push(reason); };
      const real = new SecretRedactor();
      const f = fixture('fixture response', [], {
        redactor: { redact: (text) => {
          if (phase === 'configuration' || text === 'fixture response') {
            return Promise.reject(new Error(privateValue)) as unknown as string;
          }
          return real.redact(text);
        } },
      });
      process.on('unhandledRejection', observe);
      try {
        await expect(f.service.readText()).rejects.toMatchObject({ code: 'REDACTION_FAILED' });
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', observe);
      }
    },
  );

  it.each([
    Array.from({ length: 257 }, (_, i) => 'fixture-registration-' + i),
    ['q'.repeat(65537)],
  ])('refuses unbounded registration configuration before reading', async (...secrets) => {
    const f = fixture('', secrets);
    await expect(f.service.readText()).rejects.toMatchObject({ code: 'REDACTION_FAILED' });
    expect(f.runner.readText).not.toHaveBeenCalled();
  });
});

describe('WindowsClipboardService failure and audit isolation', () => {
  it.each(['readText', 'writeText'] as const)('does not forward runner %s diagnostics or retry', async (method) => {
    const f = fixture(privateValue, [privateValue]);
    const failure = Object.assign(new Error(privateValue), {
      stdout: privateValue, stderr: privateValue, cause: new Error(privateValue), args: [privateValue],
    });
    vi.mocked(f.runner[method]).mockRejectedValue(failure);
    const error = await (method === 'readText' ? f.service.readText() : f.service.writeText(privateValue))
      .catch((cause: unknown) => cause);
    expect(error).toMatchObject({ name: 'WindowsClipboardError', code: 'CLIPBOARD_FAILED' });
    expect(f.runner[method]).toHaveBeenCalledTimes(1);
    expect(inspect(error)).not.toContain(privateValue);
    expect(error).not.toHaveProperty('cause');
    expect(error).not.toHaveProperty('stdout');
    expect(error).not.toHaveProperty('stderr');
    expect(JSON.stringify(f.events)).not.toContain(privateValue);
  });

  it('does not inspect a hostile rejection object', async () => {
    const f = fixture();
    vi.mocked(f.runner.readText).mockRejectedValue(new Proxy({}, {
      get: () => { throw new Error(privateValue); },
      getPrototypeOf: () => { throw new Error(privateValue); },
      ownKeys: () => { throw new Error(privateValue); },
    }));
    await expect(f.service.readText()).rejects.toMatchObject({ code: 'CLIPBOARD_FAILED' });
  });

  it('returns no response if audit storage fails, and suppresses its private diagnostics', async () => {
    const observed: ClipboardAuditEvent[] = [];
    const f = fixture(privateValue, [privateValue], {
      audit: { record: async (event) => { observed.push(event); throw new Error(privateValue); } },
    });
    const error = await f.service.readText().catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: 'AUDIT_FAILED' });
    expect(inspect(error)).not.toContain(privateValue);
    expect(observed).toEqual([{ operation: 'READ', result: 'SUCCESS', characterCount: privateValue.length }]);
  });

  it('reports audit failure after a write without retrying the clipboard mutation', async () => {
    const f = fixture('', [], { audit: { record: () => { throw new Error(privateValue); } } });
    await expect(f.service.writeText('valid')).rejects.toMatchObject({ code: 'AUDIT_FAILED' });
    expect(f.writes.map((bytes) => Buffer.from(bytes).toString())).toEqual(['valid']);
  });

  it('requires an audit sink before any clipboard operation', async () => {
    const f = fixture('', [], { audit: undefined as unknown as WindowsClipboardOptions['audit'] });
    await expect(f.service.readText()).rejects.toMatchObject({ code: 'AUDIT_FAILED' });
    await expect(f.service.writeText('valid')).rejects.toMatchObject({ code: 'AUDIT_FAILED' });
    expect(f.runner.readText).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
  });

  it('does not log raw or redacted clipboard content', async () => {
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((method) =>
      vi.spyOn(console, method as 'log').mockImplementation(() => {}));
    try {
      const f = fixture(privateValue, [privateValue]);
      expect((await f.service.readText()).text).toBe(marker);
      await f.service.writeText(privateValue);
      expect(spies.flatMap((spy) => spy.mock.calls)).toEqual([]);
      expect(JSON.stringify(f.events)).not.toContain(privateValue);
      expect(JSON.stringify(f.events)).not.toContain(marker);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
