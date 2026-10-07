import type { TaskId } from '@gram/domain';
import { FileService } from './file-service.js';

export class ExactPatchMismatchError extends Error {
  constructor(relativePath: string) {
    super(`Expected patch hunk was not found exactly once in ${relativePath}`);
    this.name = 'ExactPatchMismatchError';
  }
}

export class PatchService {
  constructor(private readonly files: FileService) {}

  patchExact(
    taskId: TaskId,
    relativePath: string,
    expectedOld: string,
    replacement: string,
  ): void {
    if (expectedOld.length === 0) throw new ExactPatchMismatchError(relativePath);

    const content = this.files.readText(taskId, relativePath);
    const first = content.indexOf(expectedOld);
    if (first < 0 || content.indexOf(expectedOld, first + expectedOld.length) >= 0) {
      throw new ExactPatchMismatchError(relativePath);
    }

    const updated =
      content.slice(0, first) +
      replacement +
      content.slice(first + expectedOld.length);
    this.files.writeText(taskId, relativePath, updated);
  }
}
