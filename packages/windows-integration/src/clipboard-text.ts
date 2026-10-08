import { WindowsClipboardError } from './windows-clipboard-error.js';

export const MAX_CLIPBOARD_BYTES = 1024 * 1024;

export function validateClipboardText(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0') || /[\uD800-\uDFFF]/u.test(value)) {
    throw new WindowsClipboardError('INVALID_TEXT');
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_CLIPBOARD_BYTES) {
    throw new WindowsClipboardError('PAYLOAD_TOO_LARGE');
  }
  return value;
}

export function decodeClipboardText(value: unknown): string {
  let text: string;
  try {
    if (!(value instanceof Uint8Array)) throw new Error();
    if (value.byteLength > MAX_CLIPBOARD_BYTES) throw new WindowsClipboardError('PAYLOAD_TOO_LARGE');
    // A leading U+FEFF is clipboard data. Fatal decoding never substitutes malformed bytes.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value);
  } catch (error) {
    if (error instanceof WindowsClipboardError) throw error;
    throw new WindowsClipboardError('INVALID_ENCODING');
  }
  return validateClipboardText(text);
}
