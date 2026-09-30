import type { ServiceConfig } from '../contracts.js';

export interface TunnelLaunchPlan {
  file: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
}

export function tunnelLaunchPlan(_input: ServiceConfig): Readonly<TunnelLaunchPlan> {
  throw new Error('NOT_IMPLEMENTED');
}
