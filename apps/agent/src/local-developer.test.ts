import { describe, expect, it, vi } from 'vitest';
import { LocalDeveloper, type LocalDeveloperOptions } from './local-developer.js';

function fixture() {
  const project = { canonicalPath: '/source/project', identity: 'pinned' };
  const metadata = { githubRepositoryId: 7, owner: 'owner', name: 'repo', defaultBranch: 'main' };
  const options: LocalDeveloperOptions = {
    withProject: async (_input, operation) => operation(project),
    git: { status: vi.fn(async () => ({ entries: [{ path: 'file.ts', status: ' M' }], truncated: false })),
      diff: vi.fn(async () => ({ diff: 'fake-secret', truncated: false })), log: vi.fn(async () => ({ commits: [], truncated: false })),
      inspectRepository: vi.fn(async () => metadata) },
    repositories: { register: vi.fn(async () => ({ repositoryId: 7 })), getById: vi.fn(() => ({ commands: { test: 'npm run test' } })) },
    commands: { run: vi.fn(async () => ({ taskId: '01900000-0000-7000-8000-000000000001', commandRunId: 1, status: 'SUCCEEDED' as const, exitCode: 0, stdout: 'fake-secret', stderr: '', truncated: false })) },
    redactor: { redact: value => value.replaceAll('fake-secret', '[redacted]') },
  };
  return { service: new LocalDeveloper(options), options, project, metadata };
}
describe('local developer boundary', () => {
  it('registers inspected metadata only inside authorized resolution', async () => {
    const f = fixture();
    await f.service.register({ root: 'source', path: 'project' });
    expect(f.options.repositories.register).toHaveBeenCalledWith({ ...f.metadata, localBasePath: '/source/project' });
  });
  it('rejects malformed GitHub identity before persistence', async () => {
    const f = fixture(); f.metadata.owner = '../private';
    await expect(f.service.register({ root: 'source', path: 'project' })).rejects.toThrow();
    expect(f.options.repositories.register).not.toHaveBeenCalled();
  });
  it('redacts diffs and command results without manufacturing verification', async () => {
    const f = fixture();
    expect((await f.service.diff({ root: 'source', path: 'project', staged: false })).diff).toBe('[redacted]');
    const result = await f.service.run({ repositoryId: 7, command: 'test', timeoutMs: 1000 });
    expect(result.stdout).toBe('[redacted]'); expect(result.commandRunId).toBe(1);
    expect(result).not.toHaveProperty('checksPassed');
  });
  it('denies undeclared commands and invalid workflow receipts', async () => {
    const f = fixture();
    await expect(f.service.run({ repositoryId: 7, command: 'dev', timeoutMs: 1000 })).rejects.toThrow();
    expect(f.options.commands.run).not.toHaveBeenCalled();
    vi.mocked(f.options.commands.run).mockResolvedValueOnce({ taskId: 'bad', commandRunId: 0, status: 'SUCCEEDED', exitCode: 0, stdout: '', stderr: '', truncated: false });
    await expect(f.service.run({ repositoryId: 7, command: 'test', timeoutMs: 1000 })).rejects.toThrow();
  });
  it('does not call Git after root authorization rejects', async () => {
    const f = fixture();
    f.options.withProject = async () => { throw new Error('denied'); };
    await expect(f.service.status({ root: 'source', path: 'project' })).rejects.toThrow();
    expect(f.options.git.status).not.toHaveBeenCalled();
  });
});
