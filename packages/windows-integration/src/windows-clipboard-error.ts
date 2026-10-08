export type WindowsClipboardErrorCode =
  | 'INVALID_TEXT'
  | 'INVALID_ENCODING'
  | 'PAYLOAD_TOO_LARGE'
  | 'REDACTION_FAILED'
  | 'AUDIT_FAILED'
  | 'CLIPBOARD_FAILED';

const messages: Record<WindowsClipboardErrorCode, string> = {
  INVALID_TEXT: 'Invalid clipboard text.',
  INVALID_ENCODING: 'Invalid clipboard text encoding.',
  PAYLOAD_TOO_LARGE: 'Clipboard text exceeds the 1 MiB limit.',
  REDACTION_FAILED: 'Safe clipboard output could not be verified.',
  AUDIT_FAILED: 'Clipboard audit recording failed.',
  CLIPBOARD_FAILED: 'Windows clipboard operation failed.',
};
const errorCodes = new WeakMap<object, WindowsClipboardErrorCode>();

export class WindowsClipboardError extends Error {
  readonly code: WindowsClipboardErrorCode;

  constructor(code: WindowsClipboardErrorCode) {
    const safeCode = typeof code === 'string' && Object.hasOwn(messages, code) ? code : 'CLIPBOARD_FAILED';
    super(messages[safeCode]);
    this.name = 'WindowsClipboardError';
    this.code = safeCode;
    errorCodes.set(this, safeCode);
  }
}

export function clipboardFailure(error: unknown): WindowsClipboardError {
  // WeakMap lookup invokes no getters/proxy traps and never copies native diagnostics.
  const code = typeof error === 'object' && error !== null ? errorCodes.get(error) : undefined;
  return new WindowsClipboardError(code ?? 'CLIPBOARD_FAILED');
}
