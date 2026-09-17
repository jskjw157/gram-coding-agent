import { describe, expect, it } from 'vitest';
import { canTransitionTaskStatus, createTaskId, formatTaskSequence } from './task.js';

describe('Task domain primitives', () => {
  it('creates RFC9562 version 7 task ids', () => {
    const id = createTaskId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('formats a stable human display sequence', () => {
    expect(formatTaskSequence(201)).toBe('TASK-000201');
  });

  it('allows only explicit task lifecycle transitions', () => {
    expect(canTransitionTaskStatus('QUEUED', 'WAITING_REPO_LOCK')).toBe(true);
    expect(canTransitionTaskStatus('RUNNING', 'VERIFYING')).toBe(true);
    expect(canTransitionTaskStatus('QUEUED', 'COMPLETED')).toBe(false);
    expect(canTransitionTaskStatus('COMPLETED', 'RUNNING')).toBe(false);
  });
});
