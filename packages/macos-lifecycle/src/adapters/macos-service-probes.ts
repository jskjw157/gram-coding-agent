import { execFile } from 'node:child_process';
import { isIP } from 'node:net';
import { labels, type Role } from '../contracts.js';

export interface CommandObservation { code: number; stdout: string; stderr: string }
export type PortState = 'free' | 'occupied' | 'unknown';
export type JobPresence = 'absent' | 'present' | 'unknown';
export type DisabledOverrides = Record<Role, boolean | null>;
export interface RegistryObservation { jobs: Record<Role, JobPresence>; overrides: DisabledOverrides }
const MAX_OUTPUT = 1024 * 1024;
const unknownPorts = (): Record<Role, PortState> => ({ core: 'unknown', tunnel: 'unknown' });
const states = new Set(['CLOSED', 'LISTEN', 'SYN_SENT', 'SYN_RECEIVED', 'ESTABLISHED', 'CLOSE_WAIT',
  'FIN_WAIT_1', 'CLOSING', 'LAST_ACK', 'FIN_WAIT_2', 'TIME_WAIT']);
function observation(value: unknown): CommandObservation | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 3 || !['code', 'stdout', 'stderr'].every(k => keys.includes(k))) return null;
    for (const d of Object.values(descriptors)) if (!('value' in d) || !d.enumerable) return null;
    const code: unknown = descriptors.code?.value;
    const stdout: unknown = descriptors.stdout?.value;
    const stderr: unknown = descriptors.stderr?.value;
    if (typeof code !== 'number' || !Number.isSafeInteger(code) || code < 0 || code > 255
      || typeof stdout !== 'string' || typeof stderr !== 'string'
      || Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAX_OUTPUT) return null;
    for (const text of [stdout, stderr]) {
      if ([...text].some(c => (c.charCodeAt(0) < 32 && c !== '\n' && c !== '\t') || c.charCodeAt(0) === 127)) return null;
    }
    return { code, stdout, stderr };
  } catch { return null; }
}
function portOf(endpoint: string): number | null {
  const separator = endpoint.lastIndexOf('.');
  if (separator < 1) return null;
  const host = endpoint.slice(0, separator); const port = endpoint.slice(separator + 1);
  const address = host.split('%');
  if (address.length > 2 || (address.length === 2 && (!address[1] || /[^A-Za-z0-9_-]/u.test(address[1])))) return null;
  if (host !== '*' && isIP(address[0] ?? '') === 0) return null;
  if (port === '*') return 0;
  if (port.length === 0 || port.length > 5 || /[^0-9]/u.test(port) || Number(port) > 65535) return null;
  return Number(port);
}

/** Complete numeric table only. This is a snapshot, NOT a reservation or an
 * OWNED-process proof. A bound port is refused regardless of address or state.
 * Unknown diagnostic formats remain unknown, rather than silently free.
 */
export function parseTcpSnapshot(value: unknown): Record<Role, PortState> {
  const raw = observation(value);
  if (!raw || raw.code !== 0 || raw.stderr !== '') return unknownPorts();
  const lines = raw.stdout.split('\n').map(line => line.trim()).filter(Boolean);
  if (lines[0] !== 'Active Internet connections (including servers)'
    || lines[1]?.replace(/[ \t]+/gu, ' ') !== 'Proto Recv-Q Send-Q Local Address Foreign Address (state)') return unknownPorts();
  const found: Record<Role, PortState> = { core: 'free', tunnel: 'free' };
  for (const line of lines.slice(2)) {
    const fields = line.split(/[ \t]+/u);
    if (fields.length !== 6 || !['tcp4', 'tcp6', 'tcp46'].includes(fields[0] ?? '')
      || !fields[1] || /[^0-9]/u.test(fields[1]) || !fields[2] || /[^0-9]/u.test(fields[2])
      || !states.has(fields[5] ?? '')) return unknownPorts();
    const local = portOf(fields[3] ?? '');
    if (local === null || portOf(fields[4] ?? '') === null) return unknownPorts();
    if (local === 3847) found.core = 'occupied';
    if (local === 8080) found.tunnel = 'occupied';
  }
  return found;
}
export function parseJobPresence(value: unknown, role: Role): JobPresence {
  if (role !== 'core' && role !== 'tunnel') return 'unknown';
  const raw = observation(value); if (!raw) return 'unknown';
  const missing = `Could not find service "${labels[role]}" in domain for system\n`;
  if (raw.code === 113 && raw.stdout === '' && (raw.stderr === missing || raw.stderr === `Bad request.\n${missing}`)) return 'absent';
  // Presence alone is not ownership; no pid or command from this text is used.
  if (raw.code === 0 && raw.stderr === '' && raw.stdout.startsWith(`system/${labels[role]} = {\n`)
    && raw.stdout.endsWith('}\n')) return 'present';
  return 'unknown';
}
export function parseDisabledOverrides(value: unknown): DisabledOverrides | null {
  const raw = observation(value);
  if (!raw || raw.code !== 0 || raw.stderr !== '') return null;
  const lines = raw.stdout.split('\n').map(line => line.trim()).filter(Boolean);
  if (lines[0] !== 'disabled services = {' || lines.at(-1) !== '}') return null;
  const seen = new Set<string>(); const overrides: DisabledOverrides = { core: null, tunnel: null };
  for (const line of lines.slice(1, -1)) {
    const match = /^"([^"\r\n]{1,255})"[ \t]+=>[ \t]+(true|false)$/u.exec(line);
    if (!match?.[1] || seen.has(match[1])) return null;
    seen.add(match[1]);
    for (const role of ['core', 'tunnel'] as const) if (match[1] === labels[role]) overrides[role] = match[2] === 'true';
  }
  return overrides;
}

type Probe = 'tcp' | 'core' | 'tunnel' | 'disabled' | 'plist';
/** Fixed local read-only commands. No caller-supplied executable/argv or shell.
 * Raw native output never leaves these internal adapters or enters logs.
 */
function run(probe: Probe, input?: string): Promise<CommandObservation | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  const commands: Record<Probe, readonly [string, readonly string[]]> = {
    tcp: ['/usr/sbin/netstat', ['-an', '-p', 'tcp']],
    core: ['/bin/launchctl', ['print', `system/${labels.core}`]],
    tunnel: ['/bin/launchctl', ['print', `system/${labels.tunnel}`]],
    disabled: ['/bin/launchctl', ['print-disabled', 'system']],
    plist: ['/usr/bin/plutil', ['-lint', '-']],
  };
  const command = Object.hasOwn(commands, probe) ? commands[probe] : undefined;
  if (!command) return Promise.resolve(null);
  return new Promise(resolve => {
    try {
      let inputFailed = false;
      const child = execFile(command[0], [...command[1]], { encoding: 'utf8', timeout: 2000,
        killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT, shell: false,
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C', LANG: 'C' } }, (error, stdout, stderr) => {
        const code = error ? error.code : 0;
        resolve(inputFailed || error?.killed || error?.signal || typeof code !== 'number'
          ? null : observation({ code, stdout, stderr }));
      });
      child.stdin?.on('error', () => { inputFailed = true; });
      child.stdin?.end(input);
    } catch { resolve(null); }
  });
}
export async function inspectMacPorts(): Promise<Record<Role, PortState>> { return parseTcpSnapshot(await run('tcp')); }
export async function inspectMacRegistry(): Promise<RegistryObservation | null> {
  const core = parseJobPresence(await run('core'), 'core');
  const tunnel = parseJobPresence(await run('tunnel'), 'tunnel');
  const overrides = parseDisabledOverrides(await run('disabled'));
  if (core === 'unknown' || tunnel === 'unknown' || overrides === null) return null;
  return { jobs: { core, tunnel }, overrides };
}
export async function validateMacPlists(plists: readonly string[]): Promise<boolean> {
  try {
    if (!Array.isArray(plists) || plists.length < 1 || plists.length > 2) return false;
    const inputs = [...plists];
    if (inputs.some(xml => typeof xml !== 'string' || xml.length === 0 || Buffer.byteLength(xml) > 262144)) return false;
    for (const xml of inputs) {
      const result = await run('plist', xml);
      if (!result || result.code !== 0 || result.stderr !== '') return false;
    }
    return true;
  } catch { return false; }
}
