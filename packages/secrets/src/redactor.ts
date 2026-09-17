const REDACTED = '***REDACTED***';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class SecretRedactor {
  private readonly exactSecrets: string[];

  constructor(secrets: readonly string[] = []) {
    this.exactSecrets = [...new Set(secrets.filter((secret) => secret.length > 0))].sort(
      (a, b) => b.length - a.length,
    );
  }

  redact(text: string): string {
    let output = text;
    for (const secret of this.exactSecrets) {
      output = output.replace(new RegExp(escapeRegExp(secret), 'g'), REDACTED);
    }

    output = output.replace(/(Authorization\s*:\s*Bearer\s+)[^\s]+/gi, `$1${REDACTED}`);
    output = output.replace(/\b(?:sk-[A-Za-z0-9_-]{10,}|github_pat_[A-Za-z0-9_]{10,}|gh[opusr]_[A-Za-z0-9]{10,})\b/g, REDACTED);
    return output;
  }

  redactValue(value: unknown): unknown {
    return this.redactValueInternal(value, new WeakMap<object, unknown>());
  }

  private redactValueInternal(value: unknown, seen: WeakMap<object, unknown>): unknown {
    if (typeof value === 'string') return this.redact(value);
    if (Array.isArray(value)) {
      if (seen.has(value)) return '[Circular]';
      const result: unknown[] = [];
      seen.set(value, result);
      for (const item of value) result.push(this.redactValueInternal(item, seen));
      return result;
    }
    if (value !== null && typeof value === 'object') {
      if (seen.has(value)) return '[Circular]';
      const result: Record<string, unknown> = {};
      seen.set(value, result);
      for (const [key, item] of Object.entries(value)) {
        result[key] = this.redactValueInternal(item, seen);
      }
      return result;
    }
    return value;
  }
}

export { REDACTED };
