import type { TaskId } from '@gram/domain';
import type { TaskCommandPort } from './task-command-port.js';
import { WorkspacePathGuard } from './workspace-path-guard.js';

export interface CodeSearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface CodeSearchOptions {
  guard: WorkspacePathGuard;
  commands: TaskCommandPort;
}

export interface CodeSearchInput {
  taskId: TaskId;
  pattern: string;
  relativePath?: string;
}

interface RipgrepMatchRecord {
  type?: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
    submatches?: Array<{ start?: number }>;
  };
}

export class CodeSearch {
  constructor(private readonly options: CodeSearchOptions) {}

  async search(input: CodeSearchInput): Promise<CodeSearchMatch[]> {
    if (input.pattern.length === 0) throw new Error('Search pattern must not be empty');

    const relativePath = input.relativePath ?? '.';
    const workspaceRoot = this.options.guard.resolveExisting(input.taskId, '.');
    this.options.guard.resolveExisting(input.taskId, relativePath);

    const result = await this.options.commands.run({
      taskId: input.taskId,
      cwd: workspaceRoot,
      category: 'FILESYSTEM',
      executable: 'rg',
      args: ['--json', input.pattern, relativePath],
    });

    const matches: CodeSearchMatch[] = [];
    for (const line of result.stdout.split('\n')) {
      if (line.length === 0) continue;

      let record: RipgrepMatchRecord;
      try {
        record = JSON.parse(line) as RipgrepMatchRecord;
      } catch {
        continue;
      }
      if (record.type !== 'match') continue;

      const path = record.data?.path?.text;
      const lineNumber = record.data?.line_number;
      const text = record.data?.lines?.text;
      const start = record.data?.submatches?.[0]?.start;
      if (
        path === undefined ||
        lineNumber === undefined ||
        text === undefined ||
        start === undefined
      ) {
        continue;
      }

      matches.push({
        path: path.startsWith('./') ? path.slice(2) : path,
        line: lineNumber,
        column: start + 1,
        text,
      });
    }
    return matches;
  }
}
