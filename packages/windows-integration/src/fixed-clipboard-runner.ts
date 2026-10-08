import { spawn } from 'node:child_process';
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
    try {
      const child = spawn(
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
      let failed = false;
      let length = 0;
      const chunks: Buffer[] = [];
      const fail = () => {
        failed = true;
        chunks.length = 0;
        child.kill('SIGKILL');
      };
      child.on('error', fail);
      child.stdin.on('error', fail);
      child.stdout.on('error', fail);
      child.stderr.on('error', fail);
      child.stdout.on('data', (chunk: Buffer) => {
        if (failed) return;
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
        if (failed || code !== 0 || signal !== null) {
          reject(failure());
        } else {
          resolve(Buffer.concat(chunks, length));
        }
      });
      child.stdin.end(input);
    } catch {
      reject(failure());
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
