import { decodeClipboardText, validateClipboardText } from './clipboard-text.js';
import { assertCompleteRedactionCoverage, hasCredentialShape } from './clipboard-redaction.js';
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
const tokenProbes = [
  'sk-' + 'clipboard_probe_0123456789',
  'github_pat_' + 'clipboard_probe_0123456789',
  ...['o', 'p', 'u', 's', 'r'].map((kind) => 'gh' + kind + '_' + 'clipboardprobe0123456789'),
  'Authorization: Bearer clipboard-probe-value',
].join('\n');

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

  #applyRedactor(text: string): string {
    if (!this.#redact) throw new WindowsClipboardError('REDACTION_FAILED');
    const output: unknown = this.#redact(text);
    if (typeof output === 'string') return output;
    // Reject async implementations, but consume native Promise rejections so a
    // configuration error cannot become an unhandled diagnostic containing text.
    try {
      void Promise.prototype.then.call(output, undefined, () => {});
    } catch {
      // Non-Promise values also fail closed; do not inspect their properties.
    }
    throw new WindowsClipboardError('REDACTION_FAILED');
  }

  #safeOutput(text: string): string {
    try {
      const redact = this.#redact;
      const secrets = this.#secrets;
      if (!redact || !secrets) throw new Error();
      assertCompleteRedactionCoverage(text, secrets);
      const output = validateClipboardText(this.#applyRedactor(text));
      if (secrets.some((secret) => output.includes(secret)) || hasCredentialShape(output)) {
        throw new Error();
      }
      if (this.#applyRedactor(output) !== output) throw new Error();
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
      if (this.#applyRedactor(marker) !== marker) throw new Error();
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
