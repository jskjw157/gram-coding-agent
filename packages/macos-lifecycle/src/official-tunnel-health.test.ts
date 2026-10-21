import { describe, expect, it } from 'vitest';
import { parseOfficialReadyz } from './official-tunnel-health.js';

// Literal wire cases from tunnel-client 0.0.14 commit 0f870e50:
// pkg/runtimehealth/health.go readinessStatus, not a running endpoint.
describe('official readyz response facts', () => {
  it('recognizes plain readiness without issuing a transport observation', () => {
    expect(parseOfficialReadyz(200, 'ready')).toBe('READY_RESPONSE');
  });

  it('keeps HTTP 200 MCP auth-required distinct from plain readiness and redacts errors', () => {
    expect(parseOfficialReadyz(200,
      'ready (mcp initialize requires auth: synthetic-private-diagnostic)'))
      .toBe('MCP_AUTH_REQUIRED');
  });

  it('keeps HTTP 200 MCP probe timeout distinct from plain readiness', () => {
    expect(parseOfficialReadyz(200, 'ready (mcp startup probe timed out: deadline exceeded)'))
      .toBe('MCP_PROBE_TIMEOUT');
  });

  it.each([
    'oauth discovery pending', 'oauth discovery failed: synthetic-private-diagnostic',
    'mcp startup probe pending', 'mcp startup wait failed: deadline exceeded',
    'mcp probe failed: synthetic-private-diagnostic', 'runtime dependency is not ready',
  ])('preserves HTTP 503 as a negative response without interpreting its diagnostic: %s', body => {
    expect(parseOfficialReadyz(503, body)).toBe('NOT_READY_RESPONSE');
  });

  it.each([
    [200, 'live'], [201, 'ready'], [204, ''], [401, 'ready'], [403, 'ready'],
    [500, 'ready'], ['200', 'ready'], [200, 'ready '], [200, '<html>ready</html>'],
    [200, 'ready (mcp initialize requires auth: truncated'],
    [200, 'ready (mcp startup probe timed out: truncated'],
    [200, 'ready (unknown future reason)'], [503, ''], [200, null], [200, {}],
  ])('fails closed on unsupported or malformed input (%s, %s)', (status, body) => {
    expect(parseOfficialReadyz(status, body)).toBe('UNKNOWN');
  });

  it('bounds UTF-8 bytes rather than accepting a truncated oversized diagnostic', () => {
    expect(parseOfficialReadyz(200, `ready (mcp initialize requires auth: ${'가'.repeat(1400)})`))
      .toBe('UNKNOWN');
  });

  it('never coerces input objects or invokes their code', () => {
    const hostile = { toString() { throw new Error('synthetic-private-diagnostic'); } };
    expect(parseOfficialReadyz(200, hostile)).toBe('UNKNOWN');
    expect(parseOfficialReadyz(hostile, 'ready')).toBe('UNKNOWN');
  });
});
