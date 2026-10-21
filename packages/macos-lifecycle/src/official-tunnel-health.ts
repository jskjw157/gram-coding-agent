export type OfficialReadyzFact = 'READY_RESPONSE' | 'MCP_AUTH_REQUIRED'
  | 'MCP_PROBE_TIMEOUT' | 'NOT_READY_RESPONSE' | 'UNKNOWN';

/** Plain-text /readyz protocol pinned to tunnel-client 0.0.14, commit
 * 0f870e50a973fa820d4c409000059e181e8d242b, pkg/runtimehealth/health.go
 * readinessStatus. The 4096-byte input limit follows the official CLI's
 * pkg/codexplugin/session/session.go probeEndpoint read bound.
 *
 * Pure response classification only: even READY_RESPONSE proves neither
 * native ownership, successful control-plane polling, nor authenticated MCP
 * traffic. HTTP 200 also covers auth-required and probe-timeout responses.
 * Diagnostic bodies are never returned. No IO or capability is created here.
 */
export function parseOfficialReadyz(status: unknown, body: unknown): OfficialReadyzFact {
  if (typeof body !== 'string' || body.length === 0 || body.length > 4096
    || Buffer.byteLength(body, 'utf8') > 4096) return 'UNKNOWN';
  if (status === 503) return 'NOT_READY_RESPONSE';
  if (status !== 200) return 'UNKNOWN';
  if (body === 'ready') return 'READY_RESPONSE';
  if (body.endsWith(')')) {
    if (body.startsWith('ready (mcp initialize requires auth: ')) return 'MCP_AUTH_REQUIRED';
    if (body.startsWith('ready (mcp startup probe timed out: ')) return 'MCP_PROBE_TIMEOUT';
  }
  return 'UNKNOWN';
}
