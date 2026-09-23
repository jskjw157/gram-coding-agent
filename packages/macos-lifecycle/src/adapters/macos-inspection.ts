import { execFile } from 'node:child_process';

export type AccountProbe = 'record' | 'uid' | 'gid' | 'groups' | 'admin';
export type AccountCommand = (probe: AccountProbe) => Promise<string | null>;
export interface LocalAccount { name: 'gram-agent'; uid: number; gid: number; admin: boolean; groupsComplete: true }

function oneLine(value: string | null): string | null {
  if (value === null || value.length > 16384) return null;
  const text = value.endsWith('\n') ? value.slice(0, -1) : value;
  return [...text].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ? null : text;
}
function accountId(value: string | null, minimum: number): number | null {
  const text = oneLine(value);
  if (text === null || text.length === 0 || text.length > 10 || /[^0-9]/u.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) && number >= minimum && number < 0xffff_ffff ? number : null;
}

/** Strict parser over fixed internal probes. A complete result can still report
 * admin=true; the preflight decision layer must refuse that account.
 */
export async function readLocalAccount(run: AccountCommand): Promise<LocalAccount | null> {
  try {
    const text = await run('record');
    if (text === null || text.length > 16384) return null;
    const lines = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
    if (lines.length !== 3) return null;
    const record: Record<string, string> = Object.create(null);
    for (const line of lines) {
      const separator = line.indexOf(': ');
      if (separator < 1) return null;
      const key = line.slice(0, separator); const value = oneLine(line.slice(separator + 2));
      if (!['RecordName', 'UniqueID', 'PrimaryGroupID'].includes(key) || Object.hasOwn(record, key) || value === null) return null;
      record[key] = value;
    }
    if (record.RecordName !== 'gram-agent') return null;
    const uid = accountId(record.UniqueID ?? null, 1); const gid = accountId(record.PrimaryGroupID ?? null, 0);
    if (uid === null || gid === null || accountId(await run('uid'), 1) !== uid || accountId(await run('gid'), 0) !== gid) return null;
    const groups = oneLine(await run('groups'));
    if (groups === null || groups.length === 0 || /[^0-9 ]/u.test(groups)) return null;
    const memberships = groups.split(' ').map(group => accountId(group, 0));
    if (memberships.some(group => group === null) || !memberships.includes(gid)) return null;
    const admin = oneLine(await run('admin'));
    if (admin !== 'user is a member of the group' && admin !== 'user is not a member of the group') return null;
    // A direct admin GID also refuses safety even if membership output disagrees.
    return { name: 'gram-agent', uid, gid, admin: admin === 'user is a member of the group' || memberships.includes(80), groupsComplete: true };
  } catch { return null; }
}

function runAccountProbe(probe: AccountProbe): Promise<string | null> {
  const commands: Record<AccountProbe, readonly [string, readonly string[]]> = {
    record: ['/usr/bin/dscl', ['.', '-read', '/Users/gram-agent', 'UniqueID', 'PrimaryGroupID', 'RecordName']],
    uid: ['/usr/bin/id', ['-u', 'gram-agent']],
    gid: ['/usr/bin/id', ['-g', 'gram-agent']],
    groups: ['/usr/bin/id', ['-G', 'gram-agent']],
    admin: ['/usr/bin/dsmemberutil', ['checkmembership', '-U', 'gram-agent', '-G', 'admin']],
  };
  const command = Object.hasOwn(commands, probe) ? commands[probe] : undefined;
  if (!command) return Promise.resolve(null);
  return new Promise(resolve => {
    execFile(command[0], [...command[1]], { encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 16384,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C' }, shell: false },
    (error, stdout, stderr) => resolve(error || stderr.length > 0 ? null : stdout));
  });
}
export async function inspectMacAccount(): Promise<LocalAccount | null> {
  if (process.platform !== 'darwin') return null;
  return readLocalAccount(runAccountProbe);
}
export function inspectMacHost(): { platform: string; arch: string; nodeVersion: string } {
  return { platform: process.platform, arch: process.arch, nodeVersion: process.versions.node };
}
