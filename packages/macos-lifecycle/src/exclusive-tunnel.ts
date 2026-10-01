import type { ExecutionLeaseStore } from './execution-lease.js';
import type { TunnelCustodyPort } from './adapters/native-tunnel.js';

export function withExclusiveTunnelCustody(custody: TunnelCustodyPort, leases: ExecutionLeaseStore): TunnelCustodyPort {
  void custody; void leases;
  return Object.freeze<TunnelCustodyPort>({
    async spawn() { throw new Error('NOT_IMPLEMENTED'); },
    async stop() { throw new Error('NOT_IMPLEMENTED'); },
  });
}
