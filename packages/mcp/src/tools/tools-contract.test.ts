import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  AgentTaskInput,
  registerAgentTools,
} from './agent-tools.js';
import {
  registerApprovalTools,
} from './approval-tools.js';
import {
  GitBlameInput,
  GitLogInput,
  GitStatusInput,
  registerGitTools,
} from './git-tools.js';
import {
  GitHubTaskInput,
  registerGitHubReadTools,
} from './github-tools.js';
import {
  RepoSelectorInput,
  registerRepoTools,
} from './repo-tools.js';
import {
  TaskReadInput,
  TaskListInput,
  registerTaskReadTools,
} from './task-tools.js';
import {
  VerificationTaskInput,
  registerVerificationTools,
} from './verification-tools.js';

class RecordingServer {
  readonly names: string[] = [];

  registerTool(name: string): void {
    this.names.push(name);
  }
}

function asServer(recording: RecordingServer): McpServer {
  return recording as unknown as McpServer;
}

describe('M2 MCP tool contract', () => {
  it('registers the complete required M2 read/control surface', () => {
    const recording = new RecordingServer();
    const server = asServer(recording);

    registerTaskReadTools(server, {
      get: vi.fn(),
      list: vi.fn(),
      logs: vi.fn(),
      result: vi.fn(),
    });
    registerRepoTools(server, {
      resolve: vi.fn(),
      list: vi.fn(),
      get: vi.fn(),
      inspect: vi.fn(),
      register: vi.fn(),
    });
    registerGitTools(server, {
      status: vi.fn(),
      diff: vi.fn(),
      log: vi.fn(),
      blame: vi.fn(),
    });
    registerVerificationTools(server, {
      plan: vi.fn(),
      run: vi.fn(),
      status: vi.fn(),
      evidence: vi.fn(),
    });
    registerGitHubReadTools(server, {
      getPullRequest: vi.fn(),
      checks: vi.fn(),
    });
    registerAgentTools(server, {
      status: vi.fn(),
      health: vi.fn(),
      logs: vi.fn(),
    });
    registerApprovalTools(server, {
      list: vi.fn(),
      approve: vi.fn(),
      deny: vi.fn(),
    });

    const required = [
      'task_get',
      'task_list',
      'task_logs',
      'task_result',
      'repo_resolve',
      'repo_list',
      'repo_get',
      'repo_inspect',
      'repo_register',
      'git_status',
      'git_diff',
      'git_log',
      'git_blame',
      'verification_plan',
      'verification_status',
      'verification_evidence',
      'github_pr_get',
      'github_pr_checks',
      'agent_status',
      'agent_health',
      'agent_logs',
      'approval_list',
      'approval_approve',
      'approval_deny',
    ] as const;

    for (const name of required) {
      expect(recording.names).toContain(name);
    }
    expect(new Set(recording.names).size).toBe(recording.names.length);
  });

  it('rejects unknown fields on required read/status schemas', () => {
    const taskId = '018f0000-0000-7000-8000-000000000001';

    for (const schema of [
      TaskReadInput,
      TaskListInput,
      RepoSelectorInput,
      GitStatusInput,
      GitLogInput,
      GitBlameInput,
      VerificationTaskInput,
      GitHubTaskInput,
      AgentTaskInput,
    ]) {
      expect(
        schema.safeParse(
          schema === TaskListInput
            ? { limit: 10, unexpected: true }
            : schema === RepoSelectorInput
              ? { selector: 'acme/demo', unexpected: true }
              : schema === AgentTaskInput
                ? { unexpected: true }
                : { taskId, unexpected: true },
        ).success,
      ).toBe(false);
    }
  });
});
