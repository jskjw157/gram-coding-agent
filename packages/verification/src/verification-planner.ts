import {
  ChangeClassifier,
  type ChangeClass,
  type ChangeSet,
} from './change-classifier.js';

export type VerificationCheckStatus =
  | 'PENDING'
  | 'PASS'
  | 'FAIL'
  | 'SKIPPED'
  | 'NOT_REQUIRED';

export type VerificationCheckKind = 'COMMAND' | 'NON_COMMAND';

export interface PlannedVerificationCheck {
  name: string;
  kind: VerificationCheckKind;
  required: boolean;
  status: VerificationCheckStatus;
  command?: string;
  reason?: string;
}

export interface VerificationPlan {
  changeClass: ChangeClass;
  checks: PlannedVerificationCheck[];
}

export interface RepositoryVerificationProfile {
  commands: Partial<Record<'lint' | 'test' | 'build' | 'dev', string>>;
  capabilities?: {
    browserVerification?: boolean;
  };
}

const REQUIRED_COMMANDS: Readonly<
  Record<ChangeClass, readonly ('lint' | 'test' | 'build')[]>
> = {
  DOCUMENTATION: ['lint'],
  CONFIG: ['lint', 'build'],
  FRONTEND_LOGIC: ['lint', 'test', 'build'],
  UI: ['lint', 'test', 'build'],
  BACKEND: ['test', 'build'],
  DB_MIGRATION: ['test', 'build'],
  CI_WORKFLOW: ['lint'],
  OTHER: ['lint', 'test', 'build'],
};

export class VerificationPlanner {
  constructor(private readonly classifier = new ChangeClassifier()) {}

  plan(
    changeSet: ChangeSet,
    repoProfile: RepositoryVerificationProfile,
  ): VerificationPlan {
    const changeClass = this.classifier.classify(changeSet);
    const checks: PlannedVerificationCheck[] = [];

    for (const name of REQUIRED_COMMANDS[changeClass]) {
      const command = repoProfile.commands[name];
      if (command === undefined) continue;
      checks.push({
        name,
        kind: 'COMMAND',
        required: true,
        status: 'PENDING',
        command,
      });
    }

    checks.push(
      {
        name: 'secret-scan',
        kind: 'NON_COMMAND',
        required: true,
        status: 'PENDING',
      },
      {
        name: 'diff-review',
        kind: 'NON_COMMAND',
        required: true,
        status: 'PENDING',
      },
    );

    if (changeClass === 'UI') {
      if (repoProfile.capabilities?.browserVerification === true) {
        checks.push({
          name: 'browser',
          kind: 'NON_COMMAND',
          required: true,
          status: 'PENDING',
        });
      } else {
        checks.push({
          name: 'browser',
          kind: 'NON_COMMAND',
          required: false,
          status: 'SKIPPED',
          reason: 'Repository profile does not declare browser verification capability',
        });
      }
    }

    return { changeClass, checks };
  }
}
