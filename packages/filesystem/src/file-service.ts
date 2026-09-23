import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TaskId } from '@gram/domain';
import { WorkspacePathGuard } from './workspace-path-guard.js';

export class FileService {
  constructor(private readonly guard: WorkspacePathGuard) {}

  readText(taskId: TaskId, relativePath: string): string {
    return readFileSync(this.guard.resolveExisting(taskId, relativePath), 'utf8');
  }

  writeText(taskId: TaskId, relativePath: string, content: string): void {
    const target = this.guard.resolveForWrite(taskId, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
}
