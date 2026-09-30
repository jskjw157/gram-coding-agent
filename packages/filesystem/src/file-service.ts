import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TaskId } from '@gram/domain';
import { WorkspacePathGuard } from './workspace-path-guard.js';

export class FileService {
  constructor(private readonly guard: WorkspacePathGuard) {}

  readText(taskId: TaskId, relativePath: string): string {
    return readFileSync(this.guard.resolveExisting(taskId, relativePath), 'utf8');
  }

  /** Read text only when decoding preserves the exact source bytes. */
  readTextStrict(taskId: TaskId, relativePath: string): string {
    const bytes = readFileSync(this.guard.resolveExisting(taskId, relativePath));
    const content = bytes.toString('utf8');
    if (!Buffer.from(content, 'utf8').equals(bytes)) throw new Error('Source file is not valid UTF8');
    return content;
  }

  writeText(taskId: TaskId, relativePath: string, content: string): void {
    const target = this.guard.resolveForWrite(taskId, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
}
