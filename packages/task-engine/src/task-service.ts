import { formatTaskSequence, type PublishMode, type TaskId, type TaskStatus } from '@gram/domain';
import type { AuditRepository, TaskRepository } from '@gram/persistence';

export interface CreateTaskInput {
  repo: string;
  goal: string;
  publishMode?: PublishMode;
}

export interface TaskView {
  id: TaskId;
  displayId: string;
  repo: string;
  goal: string;
  status: TaskStatus;
  publishMode: PublishMode;
}

export class InvalidCreateTaskInputError extends Error {
  constructor(field: 'repo' | 'goal') {
    super(`${field} must not be empty`);
    this.name = 'InvalidCreateTaskInputError';
  }
}

export class TaskService {
  constructor(
    private readonly tasks: TaskRepository,
    private readonly audit: AuditRepository,
  ) {}

  async create(input: CreateTaskInput): Promise<TaskView> {
    const repo = input.repo.trim();
    const goal = input.goal.trim();
    if (repo.length === 0) throw new InvalidCreateTaskInputError('repo');
    if (goal.length === 0) throw new InvalidCreateTaskInputError('goal');

    const publishMode = input.publishMode ?? 'PULL_REQUEST';
    const stored = this.tasks.create({
      repoSelector: repo,
      goal,
      taskType: 'CODING',
      publishMode,
    });

    this.audit.append({
      taskId: stored.id,
      eventType: 'TASK_CREATED',
      payload: {
        repoSelector: repo,
        publishMode,
        taskType: 'CODING',
      },
    });

    return {
      id: stored.id,
      displayId: formatTaskSequence(stored.seq),
      repo,
      goal: stored.goal,
      status: stored.status,
      publishMode: stored.publishMode,
    };
  }
}
