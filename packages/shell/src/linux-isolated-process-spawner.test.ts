import { expect, it } from 'vitest';
import { LinuxIsolatedProcessSpawner } from './linux-isolated-process-spawner.js';

it('rejects an unregistered task before launching even if it claims GIT', async () => {
  const spawner = new LinuxIsolatedProcessSpawner({
    workspaceForTask: () => undefined,
  });
  await expect(spawner.spawn({ taskId: 'unknown', cwd: '/tmp', category: 'GIT',
    executable: 'node', args: ['-e', 'process.exit(0)'], env: {} }))
    .rejects.toThrow('registered task workspace');
});

it('rejects a different cwd before helper or process setup', async () => {
  const spawner = new LinuxIsolatedProcessSpawner({
    workspaceForTask: () => ({ workspace: '/tmp/registered-task', identity: 'test' }),
  });
  await expect(spawner.spawn({ taskId: 'task', cwd: '/tmp/another-task', category: 'VERIFICATION',
    shellText: 'npm test', env: { PATH: '/attacker', HOME: '/secret-owner' } }))
    .rejects.toThrow('registered task workspace');
});
