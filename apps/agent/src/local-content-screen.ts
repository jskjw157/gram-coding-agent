import type { SecretRedactor } from '@gram/secrets';

const sensitiveKey = /(?:token|secret|password|passwd|credential|key|authorization|cookie|connection[_-]?string)/iu;
const MASK = '***REDACTED***';

/** A preview filter, not a claim to identify every unknown credential. Screen the
 * complete document before pagination/search. Raw reveal uses a separate local UI. */
export function screenLocalText(original: string, redactor: SecretRedactor): { content: string; masked: boolean } {
  let content = redactor.redact(original);
  try {
    const parsed: unknown = JSON.parse(content);
    let changed = false;
    const scrub = (value: unknown, depth: number): unknown => {
      if (depth > 60) throw new Error('Document nesting exceeds preview limit');
      if (Array.isArray(value)) return value.map(item => scrub(item, depth + 1));
      if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => {
          if (sensitiveKey.test(key)) { changed = true; return [key, MASK]; }
          return [key, scrub(item, depth + 1)];
        }));
      }
      return value;
    };
    const screened = scrub(parsed, 0);
    if (changed) content = JSON.stringify(screened, null, 2);
  } catch {
    // A malformed or over-nested structured document must not evade screening
    // merely because a sensitive member appears after another member on a line.
    if (/^[\s]*[{[]/u.test(content) && sensitiveKey.test(content)) {
      return { content: MASK, masked: true };
    }
  }

  content = content.replace(/-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/gu, MASK);
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const match = /^(\s*(?:export\s+)?["']?([\w.-]+)["']?\s*[:=]\s*)(.*)$/u.exec(line);
    if (!match || !sensitiveKey.test(match[2] ?? '')) continue;
    const value = match[3] ?? '';
    lines[i] = (match[1] ?? '') + MASK;
    const quote = value[0];
    if ((quote === '"' || quote === "'") && !hasClosingQuote(value.slice(1), quote)) {
      while (++i < lines.length) {
        const next = lines[i] ?? '';
        lines[i] = MASK;
        if (hasClosingQuote(next, quote)) break;
      }
    } else if (/^[|>][-+]?\s*$/u.test(value.trim())) {
      const indentation = /^\s*/u.exec(line)?.[0].length ?? 0;
      while (i + 1 < lines.length) {
        const next = lines[i + 1] ?? '';
        if (next.trim() && (/^\s*/u.exec(next)?.[0].length ?? 0) <= indentation) break;
        lines[++i] = MASK;
      }
    }
  }
  content = lines.join('\n').replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/giu, '$1 ' + MASK)
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, '$1' + MASK + '@');
  return { content, masked: content !== original };
}

function hasClosingQuote(text: string, quote: string): boolean {
  let escaped = false;
  for (const char of text) {
    if (char === quote && !escaped) return true;
    escaped = char === '\\' && !escaped;
    if (char !== '\\') escaped = false;
  }
  return false;
}
