import { describe, expect, it, vi } from 'vitest';
import {
  CodeSearchInput,
  FileDiffInput,
  FilePatchInput,
  FileReadInput,
  FileWriteInput,
  createCodeToolHandlers,
  type CodeToolsPort,
} from './code-tools.js';

const taskId = '018d8a73-6b4e-7000-8000-000000000001';

function ports() {
  return {
    search: vi.fn(async () => [
      { path: 'src/app.ts', line: 3, column: 7, text: 'const needle = true;\n' },
    ]),
    readText: vi.fn(async () => 'file-body\n'),
    writeText: vi.fn(async () => undefined),
    patchExact: vi.fn(async () => undefined),
    diff: vi.fn(async () => 'diff --git a/src/app.ts b/src/app.ts\n'),
  } satisfies CodeToolsPort;
}

describe('task-scoped code tool schemas', () => {
  it('accepts taskId + relativePath and rejects unrestricted absolute paths', () => {
    expect(FileReadInput.parse({ taskId, relativePath: 'src/app.ts' })).toEqual({
      taskId,
      relativePath: 'src/app.ts',
    });
    expect(FileReadInput.safeParse({ taskId, relativePath: '/etc/passwd' }).success).toBe(false);
    expect(FileWriteInput.safeParse({ taskId, relativePath: 'src/app.ts', content: '' }).success).toBe(true);
    expect(
      FilePatchInput.safeParse({
        taskId,
        relativePath: 'src/app.ts',
        expectedOld: '',
        replacement: 'x',
      }).success,
    ).toBe(false);
    expect(FileDiffInput.safeParse({ taskId, relativePath: 'src/app.ts' }).success).toBe(true);
    expect(CodeSearchInput.parse({ taskId, pattern: 'needle' }).relativePath).toBe('.');
  });
});

describe('code tool handlers', () => {
  it('routes search/read/write/patch/diff through the task-scoped application port', async () => {
    const code = ports();
    const handlers = createCodeToolHandlers(code);

    const search = await handlers.search({ taskId, pattern: 'needle', relativePath: 'src' });
    const read = await handlers.read({ taskId, relativePath: 'src/app.ts' });
    await handlers.write({ taskId, relativePath: 'src/new.ts', content: 'new\n' });
    await handlers.patch({
      taskId,
      relativePath: 'src/app.ts',
      expectedOld: 'old',
      replacement: 'new',
    });
    const diff = await handlers.diff({ taskId, relativePath: 'src/app.ts' });

    expect(code.search).toHaveBeenCalledWith({ taskId, pattern: 'needle', relativePath: 'src' });
    expect(code.readText).toHaveBeenCalledWith(taskId, 'src/app.ts');
    expect(code.writeText).toHaveBeenCalledWith(taskId, 'src/new.ts', 'new\n');
    expect(code.patchExact).toHaveBeenCalledWith(taskId, 'src/app.ts', 'old', 'new');
    expect(code.diff).toHaveBeenCalledWith(taskId, 'src/app.ts');

    expect(JSON.parse(search.content[0]?.text ?? 'null')).toHaveLength(1);
    expect(read.content[0]?.text).toBe('file-body\n');
    expect(diff.content[0]?.text).toContain('diff --git');
  });
});
