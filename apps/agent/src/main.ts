import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpHttpServer, type ApprovalToolsPort } from '@gram/mcp';
import { HealthService, StructuredLogger, type AgentHealthStatus } from '@gram/observability';
import { ApprovalRepository, AuditRepository, openDatabase, runMigrations, TaskRepository } from '@gram/persistence';
import { PolicyEngine } from '@gram/policy';
import { FileSecretProvider, SecretRedactor } from '@gram/secrets';

export interface StartAgentOptions {
  stateDirectory: string;
  secretDirectory: string;
  host?: '127.0.0.1' | '::1';
  port?: number;
  installSignalHandlers?: boolean;
  exit?: (code: number) => void;
}

export interface RunningAgent {
  host: string;
  port: number;
  url: string;
  health(): AgentHealthStatus;
  close(): Promise<void>;
}

// Local structural copy of the ApprovalConsumptionPort owned by
// packages/shell on the M2 lineage (no @gram/shell package on main yet).
// Shape is identical so the factory below ports verbatim.
export interface ApprovalConsumptionPort {
  consume(taskId: string, operationHash: string): Promise<boolean>;
}

// Thin approval adapter: the CommandRunner has already decided
// NEEDS_APPROVAL and already computed the exact operationHash, so this
// layer never re-evaluates policy, never re-derives the hash, and never
// re-classifies. It only forwards the (taskId, operationHash) it is
// handed to the durable repository. On a miss it idempotently records a
// PENDING request (so the attempt becomes visible to the MCP
// list/approve/deny surface) and still returns false, keeping the first
// blocked attempt fail-closed: CommandRunner throws ApprovalRequiredError.
export function createApprovalConsumptionPort(
  repository: ApprovalRepository,
): ApprovalConsumptionPort {
  return {
    consume: async (taskId, operationHash) => {
      if (repository.consume(taskId, operationHash) === true) return true;
      repository.request({ taskId, operationHash });
      return false;
    },
  };
}

function parseApprovalId(approvalId: string): number {
  if (/^(?:[1-9][0-9]*)$/.test(approvalId) !== true) {
    throw new Error('Invalid approval id: expected a positive decimal integer string with no leading zeros');
  }
  const id = Number(approvalId);
  if (Number.isSafeInteger(id) !== true) {
    throw new Error('Invalid approval id: expected a positive decimal integer string with no leading zeros');
  }
  return id;
}

// MCP control surface over the same durable rows: list surfaces pending
// requests (including ones recorded by blocked consume attempts above),
// approve/deny resolve them by id with the expected operation hash.
export function createApprovalToolsPort(repository: ApprovalRepository): ApprovalToolsPort {
  return {
    list: (taskId) => repository.listForTask(taskId),
    approve: (approvalId, operationHash) =>
      repository.approve(parseApprovalId(approvalId), operationHash),
    deny: (approvalId, operationHash) => repository.deny(parseApprovalId(approvalId), operationHash),
  };
}

export async function startAgent(options: StartAgentOptions): Promise<RunningAgent> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 3847;
  mkdirSync(options.stateDirectory, { recursive: true });

  const database = openDatabase(join(options.stateDirectory, 'agent.sqlite'));
  runMigrations(database);

  let mcpReady = false;
  let closed = false;
  const healthService = new HealthService({
    databaseReady: () => database.open,
    mcpReady: () => mcpReady,
  });

  const taskRepository = new TaskRepository(database);
  const auditRepository = new AuditRepository(database);
  const policyEngine = new PolicyEngine();
  void taskRepository;
  void auditRepository;
  void policyEngine;

  const secretProvider = new FileSecretProvider(options.secretDirectory);
  const secretLease = await secretProvider.getForUse('mcp-internal-secret');

  try {
    const composed = await secretLease.withValue(async (internalSecret) => {
      const logger = new StructuredLogger({ redactor: new SecretRedactor([internalSecret]) });
      const mcp = await createMcpHttpServer({
        host,
        port,
        internalSecret,
        health: () => healthService.status(),
      });
      mcpReady = true;
      logger.info('agent started', { host: mcp.host, port: mcp.port });
      return { logger, mcp };
    });

    const exit = options.exit ?? ((code: number) => process.exit(code));
    let signalHandler: (() => void) | undefined;

    const removeSignalHandlers = () => {
      if (signalHandler === undefined) return;
      process.off('SIGTERM', signalHandler);
      process.off('SIGINT', signalHandler);
      signalHandler = undefined;
    };

    const close = async () => {
      if (closed) return;
      closed = true;
      removeSignalHandlers();
      mcpReady = false;
      await composed.mcp.close();
      database.close();
      composed.logger.info('agent stopped');
    };

    if (options.installSignalHandlers !== false) {
      signalHandler = () => {
        void close().then(
          () => exit(0),
          () => exit(1),
        );
      };
      process.once('SIGTERM', signalHandler);
      process.once('SIGINT', signalHandler);
    }

    return {
      host: composed.mcp.host,
      port: composed.mcp.port,
      url: composed.mcp.url,
      health: () => healthService.status(),
      close,
    };
  } catch (error) {
    database.close();
    throw error;
  } finally {
    secretLease.dispose();
  }
}

function requiredRuntimePath(name: 'GRAM_AGENT_STATE_DIR' | 'GRAM_AGENT_SECRET_DIR'): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be configured for the agent service`);
  }
  return value;
}

const entryPath = process.argv[1];
const isDirectExecution = entryPath !== undefined && fileURLToPath(import.meta.url) === resolve(entryPath);

if (isDirectExecution) {
  void startAgent({
    stateDirectory: requiredRuntimePath('GRAM_AGENT_STATE_DIR'),
    secretDirectory: requiredRuntimePath('GRAM_AGENT_SECRET_DIR'),
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unknown startup error';
    process.stderr.write(`[gram-coding-agent] startup failed: ${message}\n`);
    process.exitCode = 1;
  });
}
