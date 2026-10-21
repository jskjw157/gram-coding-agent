import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { PolicyEngine } from '@gram/policy';
import type { SecretRedactor } from '@gram/secrets';
import {
  CommandRunner,
  type ApprovalConsumptionPort,
  type CommandOutputCapturePort,
  type CommandRequest,
  type CommandResult,
  type CommandRunStore,
  type ProcessSpawner,
  type SpawnRequest,
} from '@gram/shell';

export const REVIEW_MAX_BYTES = 256 * 1024;
const SHA = /^[a-f0-9]{40}$/;
export const REVIEW_TREE_ARGS = [
  'diff', '--raw', '-z', '--no-renames', '--no-abbrev', '--no-ext-diff', '--no-textconv',
  '--ignore-submodules=none', '--no-relative', '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
] as const;

export function assertReviewSourcePath(path: string): void {
  if (typeof path !== 'string' || path.length === 0 || path.length > 1024 || path.trim() !== path ||
      Buffer.from(path, 'utf8').toString('utf8') !== path ||
      isAbsolute(path) || path.startsWith('-') || /[\\:*?[\]\ufffd]/u.test(path) ||
      [...path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
      path.split('/').some((part) => part === '' || part.startsWith('.') ||
        /^(?:credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/i.test(part) ||
        /\.(?:pem|p12|pfx|key)$/i.test(part))) {
    throw new Error('Review path is not an ordinary task source path');
  }
}

function assertFixedRead(request: CommandRequest | SpawnRequest): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(request.taskId) || !isAbsolute(request.cwd) ||
      request.category !== 'GIT' || 'shellText' in request || request.executable !== 'git') {
    throw new Error('Review commands require a fixed task-attributed Git read');
  }
  const args = request.args ?? [];
  if (args.length === 2 && args[0] === 'rev-parse' && args[1] === '--show-toplevel') return;
  if (args.length === 2 && args[0] === 'show' && SHA.test(args[1] ?? '')) return;
  if (args.length === 3 && args[0] === 'rev-parse' && args[1] === '--verify') {
    const target = args[2] ?? '';
    if (SHA.test(target.slice(0, 40)) && target[40] === ':') {
      assertReviewSourcePath(target.slice(41));
      return;
    }
  }
  if (args.length === REVIEW_TREE_ARGS.length + 3 && REVIEW_TREE_ARGS.every((arg, index) => args[index] === arg) &&
      SHA.test(args[REVIEW_TREE_ARGS.length] ?? '') && args[REVIEW_TREE_ARGS.length + 1] === '--') {
    assertReviewSourcePath(args[REVIEW_TREE_ARGS.length + 2] ?? '');
    return;
  }
  throw new Error('Review command is not a fixed Git object read');
}

class ReviewMetadataCapture implements CommandOutputCapturePort {
  constructor(private readonly options: { homeDir: string; redactor: SecretRedactor }) {}
  redactText(text: string): string { return this.options.redactor.redact(text); }
  async capture(input: { taskId: string; commandRunId: number; stdout: string; stderr: string }) {
    const directory = join(this.options.homeDir, '.gram-agent', 'logs', 'tasks', input.taskId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stdoutPath = join(directory, `cmd-${input.commandRunId}.stdout`);
    const stderrPath = join(directory, `cmd-${input.commandRunId}.stderr`);
    const marker = (value: string): string => JSON.stringify({
      omitted: 'verification review source', bytes: Buffer.byteLength(value),
      sha256: createHash('sha256').update(value).digest('hex'),
    }) + '\n';
    writeFileSync(stdoutPath, marker(input.stdout), { encoding: 'utf8', mode: 0o600 });
    writeFileSync(stderrPath, marker(input.stderr), { encoding: 'utf8', mode: 0o600 });
    return { stdout: this.redactText(input.stdout), stderr: this.redactText(input.stderr), stdoutPath, stderrPath };
  }
}

class FixedReviewCommandRunner extends CommandRunner {
  override async run(request: CommandRequest): Promise<CommandResult> {
    // Reject unexpected command text before CommandRunner can persist its arguments.
    assertFixedRead(request);
    return super.run(request);
  }
}

export interface VerificationReviewCommandRunnerOptions {
  spawner: ProcessSpawner;
  policy: PolicyEngine;
  approvals: ApprovalConsumptionPort;
  commandRuns: CommandRunStore;
  homeDir: string;
  redactor: SecretRedactor;
  environment?: NodeJS.ProcessEnv;
}

export function createVerificationReviewCommandRunner(options: VerificationReviewCommandRunnerOptions): CommandRunner {
  if (options.spawner === undefined || typeof options.spawner.spawn !== 'function') {
    throw new Error('Verification review requires an explicit process spawner port');
  }
  return new FixedReviewCommandRunner({
    policy: options.policy, approvals: options.approvals, commandRuns: options.commandRuns,
    homeDir: options.homeDir, spawner: options.spawner,
    outputCapture: new ReviewMetadataCapture(options),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  });
}
