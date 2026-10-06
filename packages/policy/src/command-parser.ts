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
  'Unsupported shell syntax: redirection and dynamic shell expansion are not supported';

export class UnsupportedShellSyntaxError extends Error {
  constructor() {
    super(UNSUPPORTED_SHELL_SYNTAX_REASON);
    this.name = 'UnsupportedShellSyntaxError';
  }
}

function isDollar(char: string): boolean {
  return char.charCodeAt(0) === 36;
}

function isBacktick(char: string): boolean {
  return char.charCodeAt(0) === 96;
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
      if (
        (isDollar(char) && command[index + 1] === '(') ||
        isBacktick(char)
      ) {
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

    if (
      (isDollar(char) && command[index + 1] === '(') ||
      isBacktick(char)
    ) {
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

interface ShellToken {
  value: string;
  pathnameExpansion: boolean;
}

interface UnwrappedCommand {
  executable: string;
  args: string[];
  argPathnameExpansion: boolean[];
}

function tokenize(segment: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let buffer = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let pathnameExpansion = false;

  const flush = () => {
    if (buffer.length > 0) {
      tokens.push({ value: buffer, pathnameExpansion });
    }
    buffer = '';
    pathnameExpansion = false;
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

    if (
      (char === '~' && buffer.length === 0) ||
      char === '*' ||
      char === '?' ||
      char === '['
    ) {
      pathnameExpansion = true;
    }
    buffer += char;
  }
  flush();
  return tokens;
}

function unwrapCommand(tokens: ShellToken[]): UnwrappedCommand | null {
  let offset = 0;
  if (tokens[offset]?.value === 'sudo') {
    offset += 1;
    while (offset < tokens.length) {
      const token = tokens[offset]?.value;
      if (token === '--') {
        offset += 1;
        break;
      }
      if (token?.startsWith('-')) offset += 1;
      else break;
    }
  }

  if (tokens[offset]?.value === 'env') {
    offset += 1;
    while (offset < tokens.length) {
      const token = tokens[offset]?.value;
      if (token === '--') {
        offset += 1;
        break;
      }
      if (token?.startsWith('-') || token?.includes('=')) offset += 1;
      else break;
    }
  }

  const executable = tokens[offset]?.value;
  if (executable === undefined) return null;
  const argTokens = tokens.slice(offset + 1);
  return {
    executable,
    args: argTokens.map((token) => token.value),
    argPathnameExpansion: argTokens.map((token) => token.pathnameExpansion),
  };
}

function requestedPathTargetIndexes(executable: string, args: readonly string[]): number[] {
  const indexes: number[] = [];
  if (executable === 'rm' || executable === 'rmdir' || executable === 'cp' || executable === 'mv') {
    for (let index = 0; index < args.length; index += 1) {
      if (args[index]?.startsWith('-') === false) indexes.push(index);
    }
    return indexes;
  }
  if (executable === 'chmod' || executable === 'chown') {
    for (let index = 1; index < args.length; index += 1) {
      if (args[index]?.startsWith('-') === false) indexes.push(index);
    }
  }
  return indexes;
}

function requestedPathTargets(executable: string, args: readonly string[]): string[] {
  return requestedPathTargetIndexes(executable, args).flatMap((index) => {
    const value = args[index];
    return value === undefined ? [] : [value];
  });
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
    const targetIndexes = requestedPathTargetIndexes(unwrapped.executable, unwrapped.args);
    if (targetIndexes.some((index) => unwrapped.argPathnameExpansion[index] === true)) {
      throw new UnsupportedShellSyntaxError();
    }
    const requestedTargets = targetIndexes.flatMap((index) => {
      const value = unwrapped.args[index];
      return value === undefined ? [] : [value];
    });
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
