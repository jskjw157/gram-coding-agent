import { describe, expect, it, vi } from 'vitest';
import { inspectMacPorts, parseTcpSnapshot } from './adapters/macos-service-probes.js';

const header = 'Active Internet connections (including servers)\nProto Recv-Q Send-Q Local Address Foreign Address (state)\n';

// Darwin netstat truncates IPv6 hosts unless -l is requested. Simulate that
// command boundary without depending on the developer's active connections.
vi.mock('node:child_process', () => ({
  execFile: vi.fn((...args: unknown[]) => {
    const argv = args[1] as string[];
    const callback = args[3] as (error: null, stdout: string, stderr: string) => void;
    const full = argv.some(arg => /^-[^-]*l/u.test(arg));
    const host = full ? '2001:db8:1234:5678:9abc:def0:1234:5678' : '2001:db8:1234:567';
    callback(null, header + `tcp6 0 0 ${host}.3847 *.* LISTEN\n`, '');
    return { stdin: { on: vi.fn(), end: vi.fn() } };
  }),
}));

describe('complete numeric IPv6 occupancy evidence', () => {
  it.skipIf(process.platform !== 'darwin')('requests full addresses before interpreting the native table', async () => {
    // Removing the full-address option must yield UNKNOWN, never free.
    expect(await inspectMacPorts()).toEqual({ core: 'occupied', tunnel: 'free' });
  });

  it('keeps truncated IPv6 observations unknown instead of ignoring their rows', () => {
    expect(parseTcpSnapshot({ code: 0, stderr: '',
      stdout: header + 'tcp6 0 0 2001:db8:1234:567.3847 *.* LISTEN\n',
    })).toEqual({ core: 'unknown', tunnel: 'unknown' });
  });

  it('recognizes long IPv6 addresses without mistaking a foreign port for a local binding', () => {
    expect(parseTcpSnapshot({ code: 0, stderr: '', stdout: header
      + 'tcp6 0 0 2001:db8:1234:5678:9abc:def0:1234:5678.8080 2001:db8::1.3847 ESTABLISHED\n',
    })).toEqual({ core: 'free', tunnel: 'occupied' });
  });
});
