import type { SecretRedactor } from '@gram/secrets';

const sensitiveKey = /(?:token|secret|password|passwd|credential|key|authorization|cookie|connection[_-]?string|^_?auths?$)/iu;
const MASK = '***REDACTED***';

/** A preview filter, not a claim to identify every unknown credential. Screen the
 * complete document before pagination/search. Raw reveal uses a separate local UI. */
export function screenLocalText(original: string, redactor: SecretRedactor): { content: string; masked: boolean } {
  let content = redactor.redact(original);
  let parsedJson = false;
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
    parsedJson = true;
    if (changed) content = JSON.stringify(screened, null, 2);
  } catch {
    // A malformed or over-nested structured document must not evade screening
    // merely because a sensitive member appears after another member on a line.
    if (/^[\s]*[{[]/u.test(content) && sensitiveKey.test(content)) {
      return { content: MASK, masked: true };
    }
  }

  content = content.replace(/-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/gu, MASK);
  // netrc is tokenized across arbitrary whitespace, not one assignment per line.
  // Withhold the complete recognized credential stanza/document, including macdef.
  if (/(?:^|\s)(?:machine\s+\S+|default)(?:\s|$)/u.test(content) && /(?:^|\s)password(?:\s|$)/u.test(content)) {
    return { content: MASK, masked: true };
  }
  // XML entity expansion and mixed attributes make partial XML scrubbing unsafe.
  // Withhold a credential-bearing XML document rather than render raw members.
  if (/^\s*</u.test(content) && /<[^>]*(?:password|passwd|credential|secret|token|private[_-]?key|authorization)/iu.test(content)) {
    return { content: MASK, masked: true };
  }
  // YAML aliases can refer back to an ordinary-looking member. Do not expose
  // its anchor value when a credential field uses the same document graph.
  if (sensitiveKey.test(content) && /(?:^|\s)[&*][\w-]+/u.test(content)) {
    return { content: MASK, masked: true };
  }
  // Flow-style YAML can hide a credential after an ordinary outer key. Unlike
  // parsed JSON, its complete graph has not been validated and scrubbed.
  if (!parsedJson && Array.from(content.matchAll(/[{[,]\s*["']?([\w.-]+)["']?\s*:/gu))
    .some(field => sensitiveKey.test(field[1] ?? ''))) {
    return { content: MASK, masked: true };
  }
  // JavaScript configuration is not evaluated. A credential assignment or
  // object member may contain arbitrary expressions and multiline templates;
  // withhold that document rather than guess where the expression ends.
  if (/\b(?:const|let|var|module\.exports|export\s+default)\b/u.test(content)) {
    const fields = content.matchAll(/(?:^|[\s{,;])(?:export\s+)?(?:(?:const|let|var)\s+)?["']?([\w.-]+)["']?\s*[:=]/gu);
    if (Array.from(fields).some(field => sensitiveKey.test(field[1] ?? ''))) {
      return { content: MASK, masked: true };
    }
  }
  const lines = content.split('\n');
  let privateSection = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const section = /^\s*\[([^\]]+)\]\s*(?:[#;].*)?$/u.exec(line);
    if (section) privateSection = sensitiveKey.test(section[1] ?? '');
    else if (privateSection && line.trim() && !/^\s*[#;]/u.test(line)) { lines[i] = MASK; continue; }
    if (/^\s*\/\/[^\s=]+:_auth(?:Token)?\s*=/iu.test(line) ||
        /^\s*(?:machine|default)\b.*\bpassword\s+/iu.test(line)) { lines[i] = MASK; continue; }
    const match = /^(\s*(?:-\s+)?(?:export\s+)?["']?([\w.-]+)["']?\s*[:=]\s*)(.*)$/u.exec(line);
    if (!match || !sensitiveKey.test(match[2] ?? '')) continue;
    const value = match[3] ?? '';
    lines[i] = (match[1] ?? '') + MASK;
    const quote = value[0];
    const triple = value.startsWith('"""') ? '"""' : value.startsWith("'''") ? "'''" : null;
    if (triple !== null && !value.slice(3).includes(triple)) {
      while (++i < lines.length) {
        const next = lines[i] ?? '';lines[i] = MASK;
        if (next.includes(triple)) break;
      }
    } else if (triple === null && (quote === '"' || quote === "'") && !hasClosingQuote(value.slice(1), quote)) {
      while (++i < lines.length) {
        const next = lines[i] ?? '';
        lines[i] = MASK;
        if (hasClosingQuote(next, quote)) break;
      }
    } else if (!value.trim() || /^[|>](?:[1-9][-+]?|[-+][1-9]?)?(?:[ \t]+#.*)?[ \t\r]*$/u.test(value.trim())) {
      const indentation = /^\s*/u.exec(line)?.[0].length ?? 0;
      while (i + 1 < lines.length) {
        const next = lines[i + 1] ?? '';
        if (next.trim() && (/^\s*/u.exec(next)?.[0].length ?? 0) <= indentation) break;
        lines[++i] = MASK;
      }
    }
  }
  content = lines.join('\n').replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/giu, '$1 ' + MASK)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/giu, '$1' + MASK + '@');
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
