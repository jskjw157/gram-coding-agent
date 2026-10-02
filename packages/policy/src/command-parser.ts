import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export type ShellSeparator = null | '&&' | '||' | ';' | '|' | '(' | ')';

export interface NormalizedOperation {
  type: 'SHELL_COMMAND';
  raw: string;
  executable: string;
  args: string[];
  cwd: string;
  precededBy: ShellSeparator;
  requestedTargets: string[];
  canonicalTargets: string[];
  pathResolutionFailed: boolean;
}

const UNSUPPORTED_SHELL_SYNTAX_REASON =
  'Unsupported shell syntax: redirection and dynamic command substitution are not supported';

export class UnsupportedShellSyntaxError extends Error {
  constructor() {
    super(UNSUPPORTED_SHELL_SYNTAX_REASON);
    this.name = 'UnsupportedShellSyntaxError';
  }
}

function isDollar(char: string): boolean {
  return char.charCodeAt(0) === 36;
}

/**
 * Reject shell syntax whose side effects are not modeled by this parser.
 * Redirection is active outside quotes. Dynamic command substitution remains
 * active inside double quotes, but single quotes and backslash escapes keep
 * their contents literal under the parser's existing escaping model.
 */
function assertSupportedShellSyntax(command: string): void {
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === undefined) break;

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }

    if (quote === '"') {
      if (char === '"') {
        quote = null;
        continue;
      }
      if (isDollar(char) && command[index + 1] === '(') {
        throw new UnsupportedShellSyntaxError();
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (char === '>' || char === '<') {
      throw new UnsupportedShellSyntaxError();
    }

    if (isDollar(char) && command[index + 1] === '(') {
      throw new UnsupportedShellSyntaxError();
    }
  }
}

interface CommandSegment {
  text: string;
  precededBy: ShellSeparator;
}

function splitShellComposition(command: string): CommandSegment[] {
  const segments: CommandSegment[] = [];
  let buffer = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let precededBy: ShellSeparator = null;

  const flush = () => {
    const text = buffer.trim();
    if (text.length > 0) segments.push({ text, precededBy });
    buffer = '';
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === undefined) break;

    if (escaped) {
      buffer += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      buffer += char;
      escaped = true;
      continue;
    }
    if (quote !== null) {
      buffer += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      buffer += char;
      continue;
    }

    const pair = command.slice(index, index + 2);
    if (pair === '&&' || pair === '||') {
      flush();
      precededBy = pair;
      index += 1;
      continue;
    }
    if (char === ';' || char === '|' || char === '(' || char === ')') {
      flush();
      precededBy = char;
      continue;
    }
    buffer += char;
  }

  flush();
  return segments;
}

function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let buffer = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const flush = () => {
    if (buffer.length > 0) tokens.push(buffer);
    buffer = '';
  };

  for (const char of segment) {
    if (escaped) {
      buffer += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (char === quote) quote = null;
      else buffer += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      flush();
      continue;
    }
    buffer += char;
  }
  flush();
  return tokens;
}

function unwrapCommand(tokens: string[]): { executable: string; args: string[] } | null {
  let offset = 0;
  if (tokens[offset] === 'sudo') {
    offset += 1;
    while (offset < tokens.length) {
      const token = tokens[offset];
      if (token === '--') {
        offset += 1;
        break;
      }
      if (token?.startsWith('-')) offset += 1;
      else break;
    }
  }

  if (tokens[offset] === 'env') {
    offset += 1;
    while (offset < tokens.length) {
      const token = tokens[offset];
      if (token === '--') {
        offset += 1;
        break;
      }
      if (token?.startsWith('-') || token?.includes('=')) offset += 1;
      else break;
    }
  }

  const executable = tokens[offset];
  if (executable === undefined) return null;
  return { executable, args: tokens.slice(offset + 1) };
}

function requestedPathTargets(executable: string, args: readonly string[]): string[] {
  if (executable === 'rm' || executable === 'rmdir') {
    return args.filter((argument) => !argument.startsWith('-'));
  }
  if (executable === 'chmod' || executable === 'chown') {
    return args.slice(1).filter((argument) => !argument.startsWith('-'));
  }
  if (executable === 'cp' || executable === 'mv') {
    return args.filter((argument) => !argument.startsWith('-'));
  }
  return [];
}

function canonicalizeTargets(
  requestedTargets: readonly string[],
  cwd: string,
): { canonicalTargets: string[]; pathResolutionFailed: boolean } {
  const canonicalTargets: string[] = [];
  let pathResolutionFailed = false;

  for (const requested of requestedTargets) {
    const absolute = isAbsolute(requested) ? resolve(requested) : resolve(cwd, requested);
    try {
      canonicalTargets.push(realpathSync(absolute));
    } catch {
      canonicalTargets.push(absolute);
      pathResolutionFailed = true;
    }
  }
  return { canonicalTargets, pathResolutionFailed };
}

export function normalizeShellCommand(command: string, cwd: string): NormalizedOperation[] {
  assertSupportedShellSyntax(command);
  const normalizedCwd = resolve(cwd);
  return splitShellComposition(command).flatMap((segment) => {
    const unwrapped = unwrapCommand(tokenize(segment.text));
    if (unwrapped === null) return [];
    const requestedTargets = requestedPathTargets(unwrapped.executable, unwrapped.args);
    const { canonicalTargets, pathResolutionFailed } = canonicalizeTargets(requestedTargets, normalizedCwd);
    return [{
      type: 'SHELL_COMMAND' as const,
      raw: segment.text,
      executable: unwrapped.executable,
      args: unwrapped.args,
      cwd: normalizedCwd,
      precededBy: segment.precededBy,
      requestedTargets,
      canonicalTargets,
      pathResolutionFailed,
    }];
  });
}


export function normalizeExecutableCommand(
  executable: string,
  args: readonly string[],
  cwd: string,
): NormalizedOperation {
  if (executable.trim().length === 0) {
    throw new Error('Executable must not be empty');
  }

  const normalizedCwd = resolve(cwd);
  const requestedTargets = requestedPathTargets(executable, args);
  const { canonicalTargets, pathResolutionFailed } = canonicalizeTargets(
    requestedTargets,
    normalizedCwd,
  );

  return {
    type: 'SHELL_COMMAND',
    raw: [executable, ...args].join(' '),
    executable,
    args: [...args],
    cwd: normalizedCwd,
    precededBy: null,
    requestedTargets,
    canonicalTargets,
    pathResolutionFailed,
  };
}
