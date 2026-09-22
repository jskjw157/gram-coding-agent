export type AccountProbe = 'record' | 'uid' | 'gid' | 'groups' | 'admin';
export type AccountCommand = (probe: AccountProbe) => Promise<string | null>;
export interface LocalAccount { name: 'gram-agent'; uid: number; gid: number; admin: boolean; groupsComplete: true }
export async function readLocalAccount(run: AccountCommand): Promise<LocalAccount | null> { void run; return null; }
export async function inspectMacAccount(): Promise<LocalAccount | null> { return null; }
export function inspectMacHost(): { platform: string; arch: string; nodeVersion: string } { return { platform: 'unknown', arch: 'unknown', nodeVersion: 'unknown' }; }
