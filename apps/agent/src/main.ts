import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createMcpHttpServer } from '@gram/mcp';
import { HealthService, StructuredLogger, type AgentHealthStatus } from '@gram/observability';
import { AuditRepository, openDatabase, runMigrations, TaskRepository } from '@gram/persistence';
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
