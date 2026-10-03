import type { TunnelRegistrationStore } from './tunnel-registration.js';
import type { TunnelCustodyPort } from './adapters/native-tunnel.js';

export function withRegisteredTunnel(_tunnel: TunnelCustodyPort,
  _registration: Pick<TunnelRegistrationStore,'publish'>): TunnelCustodyPort {
  return Object.freeze<TunnelCustodyPort>({
    async spawn(){throw new Error('NOT_IMPLEMENTED');},
    async current(){return false;},
    async stop(){throw new Error('NOT_IMPLEMENTED');},
  });
}
