import { WindowsClipboardError } from './windows-clipboard-error.js';

const marker = '***REDACTED***';
const tokenShape = /(?:sk-[A-Za-z0-9_-]{10,}|github_pat_[A-Za-z0-9_]{10,}|gh[opusr]_[A-Za-z0-9]{10,})/u;
const otherTokenShape =
  /(?:xox[baprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/u;
const pemHeader = /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----/u;
const bearer = /(Authorization\s*:\s*Bearer\s+)([^\s]+)/giu;

export function hasCredentialShape(text: string): boolean {
  if (tokenShape.test(text) || otherTokenShape.test(text) || pemHeader.test(text)) return true;
  for (const match of text.matchAll(bearer)) {
    if (match[2] !== marker) return true;
  }
  return false;
}

interface Span {
  start: number;
  end: number;
}
interface CredentialSpan extends Span {
  valueStart: number;
}

/**
 * Verify original sensitive ranges before #19's sequential replacements can
 * destroy the patterns that identify them. This verifies coverage; it never masks.
 */
export function assertCompleteRedactionCoverage(text: string, secrets: readonly string[]): void {
  const fail = () => {
    throw new WindowsClipboardError('REDACTION_FAILED');
  };
  let matchCount = 0;
  const countMatch = () => {
    if (++matchCount > 8192) fail();
  };
  const matches: Span[] = [];
  for (const secret of new Set(secrets)) {
    // Advance one code unit to include self-overlapping original occurrences.
    for (let start = text.indexOf(secret); start !== -1; start = text.indexOf(secret, start + 1)) {
      countMatch();
      matches.push({ start, end: start + secret.length });
    }
  }
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const covered: Span[] = [];
  for (const match of matches) {
    const previous = covered.at(-1);
    if (!previous || match.start >= previous.end) covered.push(match);
    else if (match.end > previous.end) fail();
    // Contained occurrences are covered by the longer registered literal.
  }

  const credentials: CredentialSpan[] = [];
  for (const pattern of [tokenShape, otherTokenShape]) {
    for (const match of text.matchAll(new RegExp(pattern.source, 'gu'))) {
      countMatch();
      credentials.push({ start: match.index, valueStart: match.index, end: match.index + match[0].length });
    }
  }
  for (const match of text.matchAll(bearer)) {
    if (match[2] === marker) continue;
    countMatch();
    const prefix = match[1];
    if (prefix === undefined) fail();
    credentials.push({
      start: match.index,
      valueStart: match.index + (prefix?.length ?? 0),
      end: match.index + match[0].length,
    });
  }
  for (const match of text.matchAll(new RegExp(pemHeader.source, 'gu'))) {
    countMatch();
    const endMarker = '-----END ' + match[1] + '-----';
    const end = text.indexOf(endMarker, match.index + match[0].length);
    credentials.push({
      start: match.index,
      valueStart: match.index,
      end: end === -1 ? text.length : end + endMarker.length,
    });
  }

  for (const credential of credentials) {
    // Covered ranges are disjoint and ordered: find the first possible overlap.
    let low = 0;
    let high = covered.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = covered[middle];
      if (candidate && candidate.end <= credential.start) low = middle + 1;
      else high = middle;
    }
    let overlap = false;
    let complete = false;
    for (let i = low; i < covered.length; i++) {
      const range = covered[i];
      if (!range || range.start >= credential.end) break;
      overlap = true;
      if (range.start <= credential.valueStart && range.end >= credential.end) {
        complete = true;
        break;
      }
    }
    // Partial consumption can hide a token or its Bearer selector while leaving
    // secret fragments. A full registered value covering it remains safe.
    if (overlap && !complete) fail();
  }
}
