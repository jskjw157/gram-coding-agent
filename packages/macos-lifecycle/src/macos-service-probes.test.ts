import { describe, expect, it } from 'vitest';
import { parseDisabledOverrides, parseJobPresence, parseTcpSnapshot } from './adapters/macos-service-probes.js';
import type { Role } from './contracts.js';
const result = (stdout: string, code = 0, stderr = '') => ({ code, stdout, stderr });
const header = 'Active Internet connections (including servers)\nProto Recv-Q Send-Q Local Address Foreign Address (state)\n';
const row = (address: string, state = 'LISTEN', proto = 'tcp4') => `${proto} 0 0 ${address} *.* ${state}\n`;

describe('fixed-port occupancy is not process ownership', () => {
  it('accepts a complete empty table, but never empty output', () => {
    expect(parseTcpSnapshot(result(header))).toEqual({ core: 'free', tunnel: 'free' });
    expect(parseTcpSnapshot(result(''))).toEqual({ core: 'unknown', tunnel: 'unknown' });
  });
  it.each(['127.0.0.1.3847', '*.3847', '0.0.0.0.3847', '192.0.2.1.3847'])('detects %s without sending data', address => {
    expect(parseTcpSnapshot(result(header + row(address)))).toEqual({ core: 'occupied', tunnel: 'free' });
  });
  it.each(['::1.8080', '*.8080', 'fe80::1%lo0.8080'])('detects IPv6 %s', address => {
    expect(parseTcpSnapshot(result(header + row(address, 'LISTEN', 'tcp6'))).tunnel).toBe('occupied');
  });
  it('also blocks dual-stack and bound non-listening sockets conservatively', () => {
    expect(parseTcpSnapshot(result(header + row('*.3847', 'LISTEN', 'tcp46') + row('127.0.0.1.8080', 'CLOSED'))))
      .toEqual({ core: 'occupied', tunnel: 'occupied' });
  });
  it('does not confuse a remote port or a port suffix with the local fixed ports', () => {
    expect(parseTcpSnapshot(result(header + 'tcp4 0 0 127.0.0.1.53847 127.0.0.1.3847 ESTABLISHED\n')))
      .toEqual({ core: 'free', tunnel: 'free' });
  });
  it.each([
    null, result(header, 1), result(header, 0, 'permission denied'), result('Proto Recv-Q Send-Q\n'),
    result(header + 'warning: sockets changed\n'), result(header + row('localhost.3847')),
    result(header + row('127.0.0.1.99999')), result(header + row('127.0.0.1.3847', 'UNRECOGNIZED')),
    result(header + 'tcp4 0 0 127.0.0.1.3847\n'), result(header + '\u0000'),
    result(header + ' '.repeat(1024 * 1024)),
  ])('refuses incomplete or malformed observations %#', value => {
    expect(parseTcpSnapshot(value)).toEqual({ core: 'unknown', tunnel: 'unknown' });
  });
});

describe('launchd absence requires the specific native not-found result', () => {
  it.each(['core', 'tunnel'] as const)('recognizes only the fixed %s label', role => {
    const label = `com.haar.gram-agent.${role}`;
    expect(parseJobPresence(result('', 113, `Could not find service "${label}" in domain for system\n`), role)).toBe('absent');
    expect(parseJobPresence(result('', 113, `Bad request.\nCould not find service "${label}" in domain for system\n`), role)).toBe('absent');
    expect(parseJobPresence(result(`system/${label} = {\n\tactive count = 0\n}\n`), role)).toBe('present');
  });
  it.each([
    null, result('', 1, 'permission denied'), result('', 113, 'Could not find specified service'),
    result('', 113, 'Could not find service "other" in domain for system\n'),
    result('', 113, 'Could not find service "com.haar.gram-agent.core" in domain for gui/501\n'),
    result('unexpected stdout', 113, 'Could not find service "com.haar.gram-agent.core" in domain for system\n'),
    result(''), result('system/other = {\n}\n'), result('system/com.haar.gram-agent.core = {\n'),
  ])('does not interpret error or partial output as stopped %#', value => {
    expect(parseJobPresence(value, 'core')).toBe('unknown');
  });
  it('rejects a forged role without constructing an arbitrary target', () => {
    expect(parseJobPresence(result('system/other = {\n}\n'), 'other' as Role)).toBe('unknown');
  });
});

describe('desired state observations', () => {
  it('distinguishes a complete empty override table from an unavailable result', () => {
    expect(parseDisabledOverrides(result('disabled services = {\n}\n'))).toEqual({ core: null, tunnel: null });
    expect(parseDisabledOverrides(result(''))).toBeNull();
  });
  it('retains false versus true without returning other service names', () => {
    expect(parseDisabledOverrides(result('disabled services = {\n "other.service" => true\n "com.haar.gram-agent.core" => false\n "com.haar.gram-agent.tunnel" => true\n}\n')))
      .toEqual({ core: false, tunnel: true });
  });
  it.each([
    null, result('disabled services = {\n'), result('disabled services = {\n}\n', 1),
    result('disabled services = {\n "com.haar.gram-agent.core" => yes\n}\n'),
    result('disabled services = {\n "com.haar.gram-agent.core" => false\n "com.haar.gram-agent.core" => true\n}\n'),
    result('disabled services = {\n}\nwarning\n'), result('disabled services = {\n}\n', 0, 'denied'),
  ])('fails closed for unknown override data %#', value => { expect(parseDisabledOverrides(value)).toBeNull(); });
});
