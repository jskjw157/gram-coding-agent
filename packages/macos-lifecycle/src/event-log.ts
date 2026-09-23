import type { Role } from './contracts.js';
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export interface SegmentSummary { sequence: number; firstAtMs: number; lastAtMs: number }
export function decodeEventSegment(bytes: Buffer, role: Role, slot: number): SegmentSummary {
  void bytes; void role; void slot; throw new Error('NOT_IMPLEMENTED');
}
export function planEventAppend(slots: readonly (Buffer | null)[], role: Role, value: unknown): { slot: number; bytes: Buffer } {
  void slots; void role; void value; throw new Error('NOT_IMPLEMENTED');
}
