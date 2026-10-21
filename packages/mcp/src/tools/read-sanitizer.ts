const REDACTED = '***REDACTED***';

const SENSITIVE_KEY =
  /(?:authorization|credential|password|secret|token|api[_-]?key)/iu;

function redactString(value: string): string {
  return value
    .replace(
      /(Authorization\s*:\s*Bearer\s+)[^\s"']+/giu,
      '$1' + REDACTED,
    )
    .replace(
      /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{10,}|github_pat_[A-Za-z0-9_]{10,}|gh[opusr]_[A-Za-z0-9]{10,})\b/gu,
      REDACTED,
    )
    .replace(
      /(?:\/[^\s"']*)?\/\.gram-agent\/secrets\/[^\s"']+/gu,
      REDACTED,
    );
}

export function sanitizeReadValue(value: unknown): unknown {
  return sanitize(value, new WeakSet<object>());
}

function sanitize(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    return value.map((item) => sanitize(item, seen));
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = SENSITIVE_KEY.test(key)
        ? REDACTED
        : sanitize(item, seen);
    }
    return output;
  }
  return value;
}

export function safeJsonResult(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(sanitizeReadValue(value)),
      },
    ],
  };
}
