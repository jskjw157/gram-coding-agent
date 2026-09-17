import { v7 as uuidv7 } from 'uuid';

export type TaskId = string;
export type PublishMode = 'PULL_REQUEST' | 'DIRECT_MAIN';

export type TaskStatus =
  | 'QUEUED'
  | 'WAITING_REPO_LOCK'
  | 'PREPARING'
  | 'RUNNING'
  | 'VERIFYING'
  | 'PUBLISHING'
  | 'NEEDS_APPROVAL'
  | 'NEEDS_RECOVERY'
  | 'COMPLETED'
  | 'FAILED'
  | 'INTERRUPTED'
  | 'CANCELLED';

const exceptionalTransitions = [
  'NEEDS_APPROVAL',
  'NEEDS_RECOVERY',
  'FAILED',
  'INTERRUPTED',
  'CANCELLED',
] as const satisfies readonly TaskStatus[];

const taskTransitions: Record<TaskStatus, readonly TaskStatus[]> = {
  QUEUED: ['WAITING_REPO_LOCK', 'CANCELLED'],
  WAITING_REPO_LOCK: ['PREPARING', ...exceptionalTransitions],
  PREPARING: ['RUNNING', ...exceptionalTransitions],
  RUNNING: ['VERIFYING', ...exceptionalTransitions],
  VERIFYING: ['RUNNING', 'PUBLISHING', ...exceptionalTransitions],
  PUBLISHING: ['RUNNING', 'COMPLETED', ...exceptionalTransitions],
  NEEDS_APPROVAL: ['WAITING_REPO_LOCK', 'PREPARING', 'RUNNING', 'VERIFYING', 'PUBLISHING', 'FAILED', 'CANCELLED'],
  NEEDS_RECOVERY: ['WAITING_REPO_LOCK', 'PREPARING', 'RUNNING', 'VERIFYING', 'PUBLISHING', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: ['QUEUED'],
  INTERRUPTED: ['WAITING_REPO_LOCK', 'PREPARING', 'RUNNING', 'VERIFYING', 'PUBLISHING', 'NEEDS_RECOVERY', 'FAILED', 'CANCELLED'],
  CANCELLED: [],
};

export const createTaskId = (): TaskId => uuidv7();

export const formatTaskSequence = (seq: number): string => `TASK-${String(seq).padStart(6, '0')}`;

export const canTransitionTaskStatus = (from: TaskStatus, to: TaskStatus): boolean => taskTransitions[from].includes(to);
