import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { READ_CLIPBOARD_SCRIPT, WRITE_CLIPBOARD_SCRIPT } from './clipboard-scripts.js';
import { decodeClipboardText, MAX_CLIPBOARD_BYTES } from './clipboard-text.js';
import { WindowsClipboardError } from './windows-clipboard-error.js';
import type { ClipboardRunner } from './windows-clipboard-service.js';

const encodedRead = Buffer.from(READ_CLIPBOARD_SCRIPT, 'utf16le').toString('base64');
const encodedWrite = Buffer.from(WRITE_CLIPBOARD_SCRIPT, 'utf16le').toString('base64');

function clipboardEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // No WSLENV or credential inheritance from the Node worker. These are trusted
  // host process/interop paths, never request options. Native acceptance is pending.
  for (const key of ['PATH', 'WSL_INTEROP', 'WSL_DISTRO_NAME', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function executeClipboard(operation: 'READ' | 'WRITE', input: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const failure = () => new WindowsClipboardError('CLIPBOARD_FAILED');
    let child: ChildProcessWithoutNullStreams | undefined;
    let settled = false;
    let length = 0;
    const chunks: Buffer[] = [];
    const settle = (success: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (success) {
        resolve(Buffer.concat(chunks, length));
      } else {
        // Settlement must not depend on a later close event, successful signal,
        // or descendants releasing inherited pipes.
        try {
          child?.kill('SIGKILL');
        } catch {
          /* Still reject locally. */
        }
        child?.stdin.destroy();
        child?.stdout.destroy();
        child?.stderr.destroy();
        reject(failure());
      }
      chunks.length = 0;
    };
    const deadline = setTimeout(() => settle(false), 5000);
    try {
      child = spawn(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-STA',
          '-EncodedCommand',
          operation === 'READ' ? encodedRead : encodedWrite,
        ],
        {
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          timeout: 5000,
          killSignal: 'SIGKILL',
          env: clipboardEnvironment(),
        },
      );
      const fail = () => settle(false);
      child.on('error', fail);
      child.stdin.on('error', fail);
      child.stdout.on('error', fail);
      child.stderr.on('error', fail);
      child.stdout.on('data', (chunk: Buffer) => {
        if (settled) return;
        length += chunk.length;
        if (operation === 'WRITE' || length > MAX_CLIPBOARD_BYTES) {
          fail();
          return;
        }
        chunks.push(chunk);
      });
      // Stderr is never retained or forwarded. Any bytes invalidate the protocol.
      child.stderr.on('data', fail);
      child.on('close', (code, signal) => {
        settle(code === 0 && signal === null);
      });
      child.stdin.end(input);
    } catch {
      settle(false);
    }
  });
}

/** Internal transport only: package consumers use WindowsClipboardService. */
export class FixedClipboardRunner implements ClipboardRunner {
  async readText(): Promise<Uint8Array> {
    const bytes = await executeClipboard('READ', Buffer.alloc(0));
    decodeClipboardText(bytes);
    return bytes;
  }

  async writeText(utf8: Uint8Array): Promise<void> {
    // Snapshot after strict validation, so even the internal byte port is text-only.
    const text = decodeClipboardText(utf8);
    await executeClipboard('WRITE', Buffer.from(text, 'utf8'));
  }
}
