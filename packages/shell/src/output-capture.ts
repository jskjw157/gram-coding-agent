import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SecretRedactor } from '@gram/secrets';

export interface OutputCaptureOptions {
  homeDir: string;
  redactor: SecretRedactor;
}

export interface CaptureCommandOutputInput {
  taskId: string;
  commandRunId: number;
  stdout: string;
  stderr: string;
}

export interface CapturedCommandOutput {
  stdout: string;
  stderr: string;
  stdoutPath: string;
  stderrPath: string;
}

export class OutputCapture {
  constructor(private readonly options: OutputCaptureOptions) {}

  redactText(text: string): string {
    return this.options.redactor.redact(text);
  }

  async capture(input: CaptureCommandOutputInput): Promise<CapturedCommandOutput> {
    const taskDir = join(
      this.options.homeDir,
      '.gram-agent',
      'logs',
      'tasks',
      input.taskId,
    );
    mkdirSync(taskDir, { recursive: true, mode: 0o700 });

    const stdout = this.options.redactor.redact(input.stdout);
    const stderr = this.options.redactor.redact(input.stderr);
    const stdoutPath = join(taskDir, `cmd-${input.commandRunId}.stdout`);
    const stderrPath = join(taskDir, `cmd-${input.commandRunId}.stderr`);

    writeFileSync(stdoutPath, stdout, { encoding: 'utf8', mode: 0o600 });
    writeFileSync(stderrPath, stderr, { encoding: 'utf8', mode: 0o600 });

    return { stdout, stderr, stdoutPath, stderrPath };
  }
}
