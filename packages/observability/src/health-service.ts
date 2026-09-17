export interface AgentHealthStatus {
  status: 'healthy' | 'degraded';
  database: 'ok' | 'error';
  mcp: 'ready' | 'not_ready';
}

export interface HealthServiceChecks {
  databaseReady(): boolean;
  mcpReady(): boolean;
}

export class HealthService {
  constructor(private readonly checks: HealthServiceChecks) {}

  status(): AgentHealthStatus {
    const database = this.checks.databaseReady() ? 'ok' : 'error';
    const mcp = this.checks.mcpReady() ? 'ready' : 'not_ready';
    return {
      status: database === 'ok' && mcp === 'ready' ? 'healthy' : 'degraded',
      database,
      mcp,
    };
  }
}
