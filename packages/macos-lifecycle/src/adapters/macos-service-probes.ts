import type { Role } from '../contracts.js';
export interface CommandObservation { code: number; stdout: string; stderr: string }
export type PortState = 'free' | 'occupied' | 'unknown';
export type JobPresence = 'absent' | 'present' | 'unknown';
export type DisabledOverrides = Record<Role, boolean | null>;
export interface RegistryObservation { jobs: Record<Role, JobPresence>; overrides: DisabledOverrides }
export function parseTcpSnapshot(value: unknown): Record<Role, PortState> {
  void value; return { core: 'unknown', tunnel: 'unknown' };
}
export function parseJobPresence(value: unknown, role: Role): JobPresence {
  void value; void role; return 'unknown';
}
export function parseDisabledOverrides(value: unknown): DisabledOverrides | null { void value; return null; }
export async function inspectMacPorts(): Promise<Record<Role, PortState>> { return { core: 'unknown', tunnel: 'unknown' }; }
export async function inspectMacRegistry(): Promise<RegistryObservation | null> { return null; }
export async function validateMacPlists(plists: readonly string[]): Promise<boolean> { void plists; return false; }
