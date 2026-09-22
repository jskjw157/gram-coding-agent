export interface CircuitHistory {
  schemaVersion: 1;
  blocked: boolean;
  lastSeenMs: number;
  exitsMs: number[];
  lastGeneration: string | null;
  activeAttempt: null | { generation: string; startedAtMs: number };
}
export function freshHistory(nowMs: number): CircuitHistory { void nowMs; throw new Error('NOT_IMPLEMENTED'); }
export function parseHistory(value: unknown): CircuitHistory { void value; throw new Error('NOT_IMPLEMENTED'); }
export function recordExit(history: CircuitHistory, nowMs: number, intentional: boolean): CircuitHistory {
  void history; void nowMs; void intentional; throw new Error('NOT_IMPLEMENTED');
}
export function beginAttempt(history: CircuitHistory, generation: string, nowMs: number): CircuitHistory {
  void history; void generation; void nowMs; throw new Error('NOT_IMPLEMENTED');
}
export function recoverAttempt(history: CircuitHistory, nowMs: number): CircuitHistory {
  void history; void nowMs; throw new Error('NOT_IMPLEMENTED');
}
export function resetFailure(history: CircuitHistory, generation: string, nowMs: number): CircuitHistory {
  void history; void generation; void nowMs; throw new Error('NOT_IMPLEMENTED');
}
