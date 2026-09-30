import { parseConfig } from '../config.js';
import { root, type ServiceConfig } from '../contracts.js';

export interface TunnelLaunchPlan {
  file: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
}

/** Pure fixed invocation. Runtime tunnel credentials are deliberately absent:
 * a later narrow launcher may add only reviewed use-only values after every
 * compatibility/core-ownership gate. No argv/path/header comes from callers.
 */
export function tunnelLaunchPlan(input: ServiceConfig): Readonly<TunnelLaunchPlan> {
  const config = parseConfig(input);
  if (!config.tunnel.enabled) throw new Error('TUNNEL_COMPATIBILITY_REQUIRED');
  const release = `${root}/releases/${config.releaseId}`;
  const args = Object.freeze(['run', '--config', `${root}/config/tunnel-client.yaml`]);
  const env = Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: '/Users/gram-agent' });
  return Object.freeze({ file: `${release}/bin/tunnel-client`, args, cwd: release, env });
}
