import { McpServer } from '@modelcontextprotocol/server';
import { registerVerificationReviewTools, type VerificationReviewPort } from './tools/verification-review-tools.js';
import { registerLocalProjectTools, type LocalProjectToolsPort } from './tools/local-project-tools.js';
import { registerLocalFsTools, type LocalFsToolsPort } from './tools/local-fs-tools.js';
import { registerOwnerWorkspaceTools, type OwnerWorkspaceToolsPort } from './tools/owner-workspace-tools.js';
import { registerLocalDeveloperTools, type LocalDeveloperToolsPort } from './tools/local-developer-tools.js';
import { registerEgoBrowserTools, type EgoBrowserToolsPort } from './tools/ego-browser-tools.js';
import { registerCodingCapabilityTools, type CodingCapabilityPort } from './tools/coding-capability-tools.js';
import { registerAgentTools, type AgentToolsPort } from './tools/agent-tools.js';
import { registerApprovalTools, type ApprovalToolsPort } from './tools/approval-tools.js';
import { registerCodeTools, type CodeToolsPort } from './tools/code-tools.js';
import { registerGitTools, type GitToolsPort } from './tools/git-tools.js';
import {
  registerGitHubPullRequestTools,
  registerGitHubReadTools,
  type GitHubPullRequestToolsPort,
  type GitHubReadToolsPort,
} from './tools/github-tools.js';
import { registerRepoTools, type RepoToolsPort } from './tools/repo-tools.js';
import {
  registerTaskReadTools,
  registerTaskTools,
  type TaskCreatePort,
  type TaskReadPort,
} from './tools/task-tools.js';
import { registerVerificationTools, type VerificationToolsPort } from './tools/verification-tools.js';

export interface McpToolPorts {
  taskCreate?: TaskCreatePort;
  codingCapability?: CodingCapabilityPort;
  verificationReviews?: VerificationReviewPort;
  taskRead?: TaskReadPort;
  repos?: RepoToolsPort;
  codeTools?: CodeToolsPort;
  gitTools?: GitToolsPort;
  verificationTools?: VerificationToolsPort;
  githubPullRequests?: GitHubPullRequestToolsPort;
  githubRead?: GitHubReadToolsPort;
  agentTools?: AgentToolsPort;
  approvals?: ApprovalToolsPort;
  localProject?: LocalProjectToolsPort;
  localFs?: LocalFsToolsPort;
  ownerWorkspace?: OwnerWorkspaceToolsPort;
  localDeveloper?: LocalDeveloperToolsPort;
  egoBrowser?: EgoBrowserToolsPort;
}

export interface McpToolServerOptions extends McpToolPorts {
  health?: () => unknown | Promise<unknown>;
}

export function assertExclusiveFileAuthority(
  options: Pick<McpToolPorts, 'ownerWorkspace' | 'localFs' | 'localProject'>,
): void {
  if (options.ownerWorkspace !== undefined && (options.localFs !== undefined || options.localProject !== undefined)) {
    throw new Error('Owner workspace cannot share legacy filesystem authority');
  }
}

export function createMcpToolServer(options: McpToolServerOptions): McpServer {
  assertExclusiveFileAuthority(options);
  const server = new McpServer({ name: 'gram-coding-agent', version: '0.0.0' });
  registerMcpToolPorts(server, options);
  return server;
}

export function registerMcpToolPorts(server: McpServer, options: McpToolServerOptions): void {
  if (options.verificationReviews !== undefined) registerVerificationReviewTools(server, options.verificationReviews);
  if (options.agentTools !== undefined) {
    registerAgentTools(server, options.agentTools);
  } else {
    server.registerTool('agent_health', { description: 'Return the Gram coding agent health status.' }, async () => {
      const health = options.health ? await options.health() : { status: 'healthy' };
      return { content: [{ type: 'text' as const, text: JSON.stringify(health) }] };
    });
  }

  if (options.codingCapability !== undefined) registerCodingCapabilityTools(server, options.codingCapability);
  if (options.taskCreate !== undefined) registerTaskTools(server, options.taskCreate);
  if (options.taskRead !== undefined) registerTaskReadTools(server, options.taskRead);
  if (options.repos !== undefined) registerRepoTools(server, options.repos);
  if (options.codeTools !== undefined) registerCodeTools(server, options.codeTools);
  if (options.gitTools !== undefined) registerGitTools(server, options.gitTools);
  if (options.verificationTools !== undefined) {
    registerVerificationTools(server, options.verificationTools);
  }
  if (options.githubPullRequests !== undefined) {
    registerGitHubPullRequestTools(server, options.githubPullRequests);
  }
  if (options.githubRead !== undefined) registerGitHubReadTools(server, options.githubRead);
  if (options.approvals !== undefined) {
    registerApprovalTools(server, options.approvals);
  }
  if (options.localProject !== undefined) registerLocalProjectTools(server, options.localProject);
  if (options.localFs !== undefined) registerLocalFsTools(server, options.localFs);
  if (options.ownerWorkspace !== undefined) registerOwnerWorkspaceTools(server, options.ownerWorkspace);
  if (options.localDeveloper !== undefined) registerLocalDeveloperTools(server, options.localDeveloper);
  if (options.egoBrowser !== undefined) registerEgoBrowserTools(server, options.egoBrowser);
}
