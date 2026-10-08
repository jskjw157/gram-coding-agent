import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretRedactor } from '../../secrets/src/redactor.js';
import { WindowsClipboardService, type ClipboardAuditEvent } from './index.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

// This program exercises real Linux pipes/processes. It does NOT execute PowerShell.
const fixtureProgram = [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));",
  "fs.writeFileSync(path.join(__dirname, 'capture.json'), JSON.stringify({ args: process.argv.slice(2), env: process.env }));",
  "if (cfg.mode === 'early-close') { process.stdin.destroy(); process.exit(7); }",
  "if (cfg.mode === 'hang') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }",
  'const chunks = [];',
  "process.stdin.on('data', chunk => chunks.push(chunk));",
  "process.stdin.on('end', () => {",
  "  fs.writeFileSync(path.join(__dirname, 'stdin.bin'), Buffer.concat(chunks));",
  '  const bytes = Buffer.from(cfg.bytes || []);',
  "  if (cfg.mode === 'hang') return;",
  "  if (cfg.mode === 'signal') { process.kill(process.pid, 'SIGTERM'); return; }",
  "  if (cfg.mode === 'stdout-overflow') { process.stdout.write(Buffer.alloc(1048577, 120)); return; }",
  "  if (cfg.mode === 'stderr-overflow') { process.stderr.write(Buffer.alloc(65537, 120)); return; }",
  "  if (cfg.mode === 'stderr' || cfg.mode === 'nonzero') process.stderr.write(cfg.diagnostic);",
  "  if (cfg.mode === 'nonzero' || cfg.mode === 'stdout-then-fail') process.exitCode = 7;",
  "  if (cfg.mode === 'chunked') {",
  '    let offset = 0;',
  '    const send = () => { if (offset >= bytes.length) return; process.stdout.write(bytes.subarray(offset, ++offset)); setImmediate(send); };',
  '    send();',
  '  } else { process.stdout.write(bytes); }',
  '});',
].join('\n');

describe.runIf(process.platform === 'linux')('clipboard transport through real Linux fixture processes', () => {
  let directory: string;
  const secret = 'fixture-only-private-clipboard-value';
  let events: ClipboardAuditEvent[];

  function configure(mode: string, bytes = Buffer.alloc(0)) {
    writeFileSync(join(directory, 'config.json'), JSON.stringify({ mode, bytes: [...bytes], diagnostic: secret }));
  }

  function service() {
    return new WindowsClipboardService({
      redactor: new SecretRedactor([secret]),
      registeredSecrets: [secret],
      audit: {
        record: (event) => {
          events.push(event);
        },
      },
    });
  }

  function capture() {
    return JSON.parse(readFileSync(join(directory, 'capture.json'), 'utf8')) as {
      args: string[];
      env: Record<string, string>;
    };
  }

  beforeEach(() => {
    vi.mocked(spawn).mockClear();
    directory = mkdtempSync(join(tmpdir(), 'gram-clipboard-process-'));
    events = [];
    writeFileSync(join(directory, 'powershell.exe'), '#!' + process.execPath + '\n' + fixtureProgram, { mode: 0o700 });
    configure('success');
    vi.stubEnv('PATH', directory);
    vi.stubEnv('GRAM_CLIPBOARD_PRIVATE_SENTINEL', secret);
    vi.stubEnv('WSLENV', 'GRAM_CLIPBOARD_PRIVATE_SENTINEL');
  });

  afterEach(() => {
    for (const result of vi.mocked(spawn).mock.results) {
      if (result.type !== 'return') continue;
      const child = result.value as ChildProcess;
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it('redacts a real private stdout pipe before returning and records no clipboard content', async () => {
    configure('chunked', Buffer.from('before ' + secret + ' after'));
    const f = service();
    expect(await f.readText()).toEqual({ text: 'before ***REDACTED*** after', redacted: true });
    expect(readFileSync(join(directory, 'stdin.bin')).byteLength).toBe(0);
    expect(events).toEqual([{ operation: 'READ', result: 'SUCCESS', characterCount: secret.length + 13 }]);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(capture().env).not.toHaveProperty('GRAM_CLIPBOARD_PRIVATE_SENTINEL');
    expect(capture().env).not.toHaveProperty('WSLENV');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('masks tokens split across actual stdout chunks', async () => {
    const token = 'github_pat_' + 'fixture_0123456789';
    configure('chunked', Buffer.from('left ' + token + ' right'));
    expect(await service().readText()).toEqual({ text: 'left ***REDACTED*** right', redacted: true });
  });

  it('preserves UTF-8 split across actual chunks, including a leading U+FEFF', async () => {
    const text = '\ufeff한글 🧵\r\n \ufffd';
    configure('chunked', Buffer.from(text));
    expect(await service().readText()).toEqual({ text, redacted: false });
  });

  it.each([
    '',
    '-EncodedCommand attacker',
    ' \t한글 🧵\r\n "quote" \'apostrophe\' ',
    '"; Start-Process calc.exe; #',
    '$(Start-Process calc.exe) | & cmd.exe /c echo sentinel',
    'line\n`backtick` %COMSPEC% $env:PRIVATE ${variable} ; & | > <',
  ])('sends clipboard text only as literal stdin, with fixed executable/argv/options', async (text) => {
    await service().writeText(text);
    expect(readFileSync(join(directory, 'stdin.bin'))).toEqual(Buffer.from(text, 'utf8'));
    const { args, env } = capture();
    expect(args.slice(0, 5)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand']);
    expect(args).toHaveLength(6);
    expect(args[5]).toMatch(/^[A-Za-z0-9+/]+={0,2}$/u);
    expect(Buffer.from(args[5] ?? '', 'base64').toString('utf16le')).not.toContain('Start-Process');
    expect(args).not.toContain(text || 'unexpected-empty-argv');
    expect(env).not.toHaveProperty('GRAM_CLIPBOARD_PRIVATE_SENTINEL');
    expect(spawn).toHaveBeenCalledExactlyOnceWith('powershell.exe', args, {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 5000,
      killSignal: 'SIGKILL',
      env: expect.any(Object),
    });
    expect(JSON.stringify(events)).not.toContain('Start-Process');
  });

  it('uses identical write scripts for unrelated user inputs and a distinct fixed read script', async () => {
    await service().writeText('first');
    const first = capture().args;
    await service().writeText('"; $(payload); "' + secret);
    expect(capture().args).toEqual(first);
    await service().readText();
    const read = capture().args;
    expect(read.slice(0, 5)).toEqual(first.slice(0, 5));
    expect(read[5]).not.toBe(first[5]);
    expect(read).toHaveLength(6);
  });

  it.each([1048575, 1048576])('transports %i bytes without truncation in either direction', async (size) => {
    const text = 'x'.repeat(size);
    await service().writeText(text);
    expect(readFileSync(join(directory, 'stdin.bin')).byteLength).toBe(size);
    configure('success', Buffer.from(text));
    expect((await service().readText()).text.length).toBe(size);
  });

  it('rejects an oversized write before launching any child', async () => {
    await expect(service().writeText('x'.repeat(1048577))).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(spawn).not.toHaveBeenCalled();
    expect(existsSync(join(directory, 'capture.json'))).toBe(false);
  });

  it.each(['nonzero', 'stdout-then-fail', 'signal', 'stdout-overflow', 'stderr-overflow', 'stderr'])(
    'fails safely for %s without leaking to parent stdout/stderr/audit or retrying',
    async (mode) => {
      configure(mode, Buffer.from(secret));
      const output: string[] = [];
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });
      try {
        const error = await service()
          .readText()
          .catch((cause: unknown) => cause);
        expect(error).toMatchObject({ name: 'WindowsClipboardError', code: 'CLIPBOARD_FAILED' });
        expect(inspect(error)).not.toContain(secret);
        expect(error).not.toHaveProperty('cause');
        expect(error).not.toHaveProperty('stdout');
        expect(error).not.toHaveProperty('stderr');
        expect(JSON.stringify(events)).not.toContain(secret);
        expect(output.join('')).not.toContain(secret);
        expect(spawn).toHaveBeenCalledTimes(1);
      } finally {
        stdout.mockRestore();
        stderr.mockRestore();
      }
    },
  );

  it.each([[0xff], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xe3, 0x81], [0x61, 0]])(
    'rejects invalid text bytes received from a successful child',
    async (...bytes) => {
      configure('success', Buffer.from(bytes));
      await expect(service().readText()).rejects.toMatchObject({ name: 'WindowsClipboardError' });
      expect(events[0]?.result).toBe('FAILURE');
      expect(spawn).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects unexpected write stdout, even when the child exits successfully', async () => {
    configure('success', Buffer.from(secret));
    await expect(service().writeText('valid')).rejects.toMatchObject({ code: 'CLIPBOARD_FAILED' });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it('handles an early stdin close without exposing an unhandled pipe error', async () => {
    configure('early-close');
    await expect(service().writeText('x'.repeat(1048576))).rejects.toMatchObject({ code: 'CLIPBOARD_FAILED' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('fails when powershell.exe is unavailable without a fallback', async () => {
    rmSync(join(directory, 'powershell.exe'));
    await expect(service().readText()).rejects.toMatchObject({ code: 'CLIPBOARD_FAILED' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('kills a stuck child at the deadline even if it ignores SIGTERM', async () => {
    configure('hang');
    const started = performance.now();
    await expect(service().readText()).rejects.toMatchObject({ code: 'CLIPBOARD_FAILED' });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(performance.now() - started).toBeLessThan(8000);
    const child = vi.mocked(spawn).mock.results[0]?.value as ChildProcess;
    expect(child.signalCode).toBe('SIGKILL');
  }, 9000);
});
