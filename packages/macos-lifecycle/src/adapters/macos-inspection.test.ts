import { describe, expect, it } from 'vitest';
import { readLocalAccount, inspectMacAccount, inspectMacHost, type AccountProbe } from './macos-inspection.js';
const output: Record<AccountProbe, string> = { record: 'PrimaryGroupID: 20\nRecordName: gram-agent\nUniqueID: 502\n', uid: '502\n', gid: '20\n', groups: '20 12 61\n', admin: 'user is not a member of the group\n' };
describe('fixed local macOS account inspection', () => {
  it('requires local directory record, matching id values, complete groups and an admin membership result', async () => {
    const calls: AccountProbe[] = [];
    expect(await readLocalAccount(async name => { calls.push(name); return output[name]; }))
      .toEqual({ name: 'gram-agent', uid: 502, gid: 20, admin: false, groupsComplete: true });
    expect(calls).toEqual(['record', 'uid', 'gid', 'groups', 'admin']);
  });
  it('reports admin membership instead of calling the account safe', async () => {
    expect((await readLocalAccount(async name => name === 'admin' ? 'user is a member of the group\n' : output[name]))?.admin).toBe(true);
  });
  it.each([
    ['record', null], ['record', 'UniqueID: 502\nPrimaryGroupID: 20\nRecordName: someone-else\n'],
    ['record', 'UniqueID: 502\nUniqueID: 503\nPrimaryGroupID: 20\nRecordName: gram-agent\n'],
    ['uid', '0\n'], ['uid', '503\n'], ['gid', '21\n'], ['groups', '12 61\n'],
    ['groups', '20 unknown\n'], ['groups', '20\n12\n'], ['admin', 'unknown'], ['admin', null],
  ] as const)('refuses incomplete or inconsistent %s result %j', async (probe, value) => {
    expect(await readLocalAccount(async name => name === probe ? value : output[name])).toBeNull();
  });
  it('does not disclose command errors', async () => {
    expect(await readLocalAccount(async () => { throw new Error('PRIVATE_ERROR'); })).toBeNull();
  });
  it('returns the actual process environment without inspecting a release binary', () => {
    expect(inspectMacHost()).toEqual({ platform: process.platform, arch: process.arch, nodeVersion: process.versions.node });
  });
  it('never fabricates the dedicated account on this host', async () => {
    const account = await inspectMacAccount();
    if (account !== null) expect(account).toMatchObject({ name: 'gram-agent', groupsComplete: true });
    if (process.platform !== 'darwin') expect(account).toBeNull();
  });
});
