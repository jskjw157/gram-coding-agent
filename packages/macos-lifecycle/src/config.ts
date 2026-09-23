import { createHash } from 'node:crypto';
import type { ServiceConfig } from './contracts.js';

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_CONFIG');
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('INVALID_CONFIG');
  const output: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error('INVALID_CONFIG');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new Error('INVALID_CONFIG');
    output[key] = descriptor.value;
  }
  return output;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new Error('INVALID_CONFIG');
  }
}
function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

/** A configuration is data, not a command, authority grant, or credential. */
export function parseConfig(value: unknown): ServiceConfig {
  try {
    const input = record(value);
    exact(input, ['schemaVersion', 'mode', 'runtimeUser', 'releaseId', 'releaseDigest', 'tunnel']);
    if (input.schemaVersion !== 1 || input.mode !== 'LAB_ONLY' || input.runtimeUser !== 'gram-agent'
      || typeof input.releaseId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.releaseId)
      || !digest(input.releaseDigest)) throw new Error('INVALID_CONFIG');
    const tunnel = record(input.tunnel);
    let normalizedTunnel: ServiceConfig['tunnel'];
    if (tunnel.enabled === false) {
      exact(tunnel, ['enabled']);
      normalizedTunnel = { enabled: false };
    } else if (tunnel.enabled === true) {
      exact(tunnel, ['enabled', 'compatibilityDigest', 'credentialRef']);
      if (!digest(tunnel.compatibilityDigest) || tunnel.credentialRef !== 'test-tunnel-key') {
        throw new Error('INVALID_CONFIG');
      }
      normalizedTunnel = { enabled: true, compatibilityDigest: tunnel.compatibilityDigest,
        credentialRef: 'test-tunnel-key' };
    } else throw new Error('INVALID_CONFIG');
    return { schemaVersion: 1, mode: 'LAB_ONLY', runtimeUser: 'gram-agent',
      releaseId: input.releaseId, releaseDigest: input.releaseDigest, tunnel: normalizedTunnel };
  } catch {
    // Never attach the offending object, a cause, or a provider exception.
    throw new Error('INVALID_CONFIG');
  }
}
export function configDigest(config: ServiceConfig): string {
  return createHash('sha256').update(JSON.stringify(parseConfig(config)), 'utf8').digest('hex');
}
