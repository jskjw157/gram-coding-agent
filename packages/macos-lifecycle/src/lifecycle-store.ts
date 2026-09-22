import type { Role } from './contracts.js';
import type { CircuitHistory } from './circuit.js';
export interface CircuitFiles {
  read(role: Role): Promise<Buffer | null>;
  compareAndSwap(role: Role, expectedDigest: string | null, bytes: Buffer): Promise<void>;
}
export interface HistorySnapshot { role: Role; digest: string; history: CircuitHistory }
export type CircuitMutation =
  | { kind: 'begin'; generation: string; nowMs: number }
  | { kind: 'exit'; generation: string; nowMs: number; intentional: boolean }
  | { kind: 'recover'; nowMs: number }
  | { kind: 'reset'; generation: string; nowMs: number };
export function encodeHistory(history: CircuitHistory): Buffer { void history; throw new Error('NOT_IMPLEMENTED'); }
export function decodeHistory(bytes: Buffer): CircuitHistory { void bytes; throw new Error('NOT_IMPLEMENTED'); }
export class LifecycleStore {
  constructor(private readonly files: CircuitFiles) {}
  async read(role: Role): Promise<HistorySnapshot> { void role; void this.files; throw new Error('NOT_IMPLEMENTED'); }
  async initializeNew(role: Role, nowMs: number): Promise<HistorySnapshot> {
    void role; void nowMs; throw new Error('NOT_IMPLEMENTED');
  }
  async write(role: Role, snapshot: HistorySnapshot, mutation: CircuitMutation): Promise<HistorySnapshot> {
    void role; void snapshot; void mutation; throw new Error('NOT_IMPLEMENTED');
  }
}
