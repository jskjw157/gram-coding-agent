import { canTransitionTaskStatus, type TaskId, type TaskStatus } from '@gram/domain';
import type { TaskRepository } from '@gram/persistence';

export class InvalidTaskTransitionError extends Error {
  constructor(from: TaskStatus, to: TaskStatus) {
    super(`Task transition is not allowed: ${from} -> ${to}`);
    this.name = 'InvalidTaskTransitionError';
  }
}

export class TaskStateMachine {
  constructor(private readonly tasks: TaskRepository) {}

  transition(taskId: TaskId, from: TaskStatus, to: TaskStatus): void {
    if (!canTransitionTaskStatus(from, to)) {
      throw new InvalidTaskTransitionError(from, to);
    }
    this.tasks.transition(taskId, from, to);
  }
}
