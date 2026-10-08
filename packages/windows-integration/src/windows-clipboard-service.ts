import { decodeClipboardText, validateClipboardText } from './clipboard-text.js';
import { FixedClipboardRunner } from './fixed-clipboard-runner.js';
import { clipboardFailure, WindowsClipboardError } from './windows-clipboard-error.js';

export interface ClipboardReadResult {
  readonly text: string;
  readonly redacted: boolean;
}

export interface ClipboardAuditEvent {
  readonly operation: 'READ' | 'WRITE';
  readonly result: 'SUCCESS' | 'FAILURE';
  /** Number of UTF-16 code units; null if no valid text was obtained. */
  readonly characterCount: number | null;
}

/** Trusted in-memory transport. Its raw bytes must never be returned by an MCP tool. */
export interface ClipboardRunner {
  readText(): Promise<Uint8Array>;
  writeText(utf8: Uint8Array): Promise<void>;
}

export interface WindowsClipboardOptions {
  /** The host's existing, configured SecretRedactor. No identity/default fallback. */
  readonly redactor: { redact(text: string): string };
  /** Complete trusted registration snapshot, matching that SecretRedactor. */
  readonly registeredSecrets: readonly string[];
  readonly audit: { record(event: ClipboardAuditEvent): void | Promise<void> };
  readonly runner?: ClipboardRunner;
}

const marker = '***REDACTED***';
// The same families as #19, without its leading word-boundary blind spot.
const tokenShape = /(?:sk-[A-Za-z0-9_-]{10,}|github_pat_[A-Za-z0-9_]{10,}|gh[opusr]_[A-Za-z0-9]{10,})/u;
// Fail closed on common additional credential shapes that #19 does not mask itself.
const unsupportedCredential = /(?:xox[baprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----)/u;
const tokenProbes = [
  'sk-' + 'clipboard_probe_0123456789',
  'github_pat_' + 'clipboard_probe_0123456789',
  ...['o', 'p', 'u', 's', 'r'].map((kind) => 'gh' + kind + '_' + 'clipboardprobe0123456789'),
  'Authorization: Bearer clipboard-probe-value',
].join('\n');

function hasCredentialShape(text: string): boolean {
  if (tokenShape.test(text) || unsupportedCredential.test(text)) return true;
  for (const match of text.matchAll(/Authorization\s*:\s*Bearer\s+([^\s]+)/giu)) {
    if (match[1] !== marker) return true;
  }
  return false;
}

export class WindowsClipboardService {
  #redact: ((text: string) => string) | undefined;
  #secrets: readonly string[] | undefined;
  #record: ((event: ClipboardAuditEvent) => void | Promise<void>) | undefined;
  #runner: ClipboardRunner | undefined;

  constructor(options: WindowsClipboardOptions) {
    // Configuration is trusted composition, never MCP request data. Snapshot bindings and
    // registrations; private fields also keep secret configuration out of serialization.
    try {
      const audit = options.audit;
      if (typeof audit?.record === 'function') this.#record = audit.record.bind(audit);
      const redactor = options.redactor;
      if (typeof redactor?.redact === 'function') this.#redact = redactor.redact.bind(redactor);
      const secrets = options.registeredSecrets;
      if (Array.isArray(secrets)) this.#secrets = Object.freeze([...secrets]);
      const runner = options.runner ?? new FixedClipboardRunner();
      if (runner && typeof runner.readText === 'function' && typeof runner.writeText === 'function') {
        this.#runner = { readText: runner.readText.bind(runner), writeText: runner.writeText.bind(runner) };
      }
    } catch {
      this.#redact = undefined;
      this.#secrets = undefined;
    }
  }

  #safeOutput(text: string): string {
    try {
      const redact = this.#redact;
      const secrets = this.#secrets;
      if (!redact || !secrets) throw new Error();
      const output = validateClipboardText(redact(text));
      if (secrets.some((secret) => output.includes(secret)) || hasCredentialShape(output)) {
        throw new Error();
      }
      if (redact(output) !== output) throw new Error();
      return output;
    } catch {
      throw new WindowsClipboardError('REDACTION_FAILED');
    }
  }

  #verifyRedaction(): void {
    try {
      if (!this.#redact || !this.#secrets) throw new Error();
      // Configuration is bounded too; overlapping markers can amplify sequential replacement.
      if (this.#secrets.length > 256) throw new Error();
      let registrationBytes = 0;
      for (const secret of this.#secrets) {
        validateClipboardText(secret);
        if (!secret || marker.includes(secret)) throw new Error();
        registrationBytes += Buffer.byteLength(secret, 'utf8');
        if (registrationBytes > 65536) throw new Error();
      }
      if (this.#redact(marker) !== marker) throw new Error();
      this.#safeOutput(tokenProbes);
      for (const secret of this.#secrets) this.#safeOutput(secret);
    } catch {
      throw new WindowsClipboardError('REDACTION_FAILED');
    }
  }

  async #audit(event: ClipboardAuditEvent): Promise<void> {
    try {
      if (!this.#record) throw new Error();
      await this.#record(Object.freeze(event));
    } catch {
      throw new WindowsClipboardError('AUDIT_FAILED');
    }
  }

  async readText(): Promise<ClipboardReadResult> {
    if (!this.#record) throw new WindowsClipboardError('AUDIT_FAILED');
    let count: number | null = null;
    let result: ClipboardReadResult;
    try {
      this.#verifyRedaction();
      let bytes: Uint8Array;
      try {
        if (!this.#runner) throw new Error();
        bytes = await this.#runner.readText();
      } catch {
        throw new WindowsClipboardError('CLIPBOARD_FAILED');
      }
      const raw = decodeClipboardText(bytes);
      count = raw.length;
      const text = this.#safeOutput(raw);
      result = Object.freeze({ text, redacted: text !== raw });
    } catch (error) {
      await this.#audit({ operation: 'READ', result: 'FAILURE', characterCount: count });
      throw clipboardFailure(error);
    }
    await this.#audit({ operation: 'READ', result: 'SUCCESS', characterCount: count });
    return result;
  }

  async writeText(text: string): Promise<void> {
    if (!this.#record) throw new WindowsClipboardError('AUDIT_FAILED');
    let count: number | null = null;
    try {
      const valid = validateClipboardText(text);
      count = valid.length;
      this.#verifyRedaction();
      try {
        if (!this.#runner) throw new Error();
        await this.#runner.writeText(Buffer.from(valid, 'utf8'));
      } catch {
        throw new WindowsClipboardError('CLIPBOARD_FAILED');
      }
    } catch (error) {
      await this.#audit({ operation: 'WRITE', result: 'FAILURE', characterCount: count });
      throw clipboardFailure(error);
    }
    await this.#audit({ operation: 'WRITE', result: 'SUCCESS', characterCount: count });
  }
}
