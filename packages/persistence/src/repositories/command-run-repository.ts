import type Database from 'better-sqlite3';
import type { TaskId } from '@gram/domain';

export type CommandRunStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED';

export interface StartCommandRunInput {
  taskId: TaskId;
  category: string;
  cwd: string;
  executable?: string | null;
  args?: readonly string[] | null;
  shellText?: string | null;
  startedAt?: string;
}

export interface FinishCommandRunInput {
  status: Exclude<CommandRunStatus, 'RUNNING'>;
  exitCode: number | null;
  stdoutPath?: string | null;
  stderrPath?: string | null;
  truncated?: boolean;
  finishedAt?: string;
}

export interface StoredCommandRun {
  id: number;
  taskId: TaskId;
  category: string;
  cwd: string;
  executable: string | null;
  args: string[] | null;
  shellText: string | null;
  status: CommandRunStatus;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  stdoutPath: string | null;
  stderrPath: string | null;
  truncated: boolean;
}

interface CommandRunRow {
  id: number;
  task_id: TaskId;
  category: string;
  cwd: string;
  executable: string | null;
  args_json: string | null;
  shell_text: string | null;
  status: CommandRunStatus;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  stdout_path: string | null;
  stderr_path: string | null;
  truncated: number;
}

function decode(row: CommandRunRow): StoredCommandRun {
  return {
    id: row.id,
    taskId: row.task_id,
    category: row.category,
    cwd: row.cwd,
    executable: row.executable,
    args: row.args_json === null ? null : (JSON.parse(row.args_json) as string[]),
    shellText: row.shell_text,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    exitCode: row.exit_code,
    stdoutPath: row.stdout_path,
    stderrPath: row.stderr_path,
    truncated: row.truncated === 1,
  };
}

export class CommandRunRepository {
  constructor(private readonly db: Database.Database) {}

  start(input: StartCommandRunInput): number {
    const result = this.db
      .prepare(`
        INSERT INTO command_runs(
          task_id, category, cwd, executable, args_json, shell_text, status, started_at, truncated
        ) VALUES (?, ?, ?, ?, ?, ?, 'RUNNING', ?, 0)
      `)
      .run(
        input.taskId,
        input.category,
        input.cwd,
        input.executable ?? null,
        input.args === undefined || input.args === null ? null : JSON.stringify(input.args),
        input.shellText ?? null,
        input.startedAt ?? new Date().toISOString(),
      );
    return Number(result.lastInsertRowid);
  }

  finish(id: number, input: FinishCommandRunInput): void {
    const result = this.db
      .prepare(`
        UPDATE command_runs
        SET status = ?, finished_at = ?, exit_code = ?, stdout_path = ?, stderr_path = ?, truncated = ?
        WHERE id = ? AND status = 'RUNNING'
      `)
      .run(
        input.status,
        input.finishedAt ?? new Date().toISOString(),
        input.exitCode,
        input.stdoutPath ?? null,
        input.stderrPath ?? null,
        input.truncated === true ? 1 : 0,
        id,
      );
    if (result.changes !== 1) throw new Error(`Command run ${id} is not RUNNING`);
  }

  get(id: number): StoredCommandRun | undefined {
    const row = this.db
      .prepare('SELECT * FROM command_runs WHERE id = ?')
      .get(id) as CommandRunRow | undefined;
    return row === undefined ? undefined : decode(row);
  }
}
