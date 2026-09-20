import type { HostFacts, PlatformDetection, ReadinessResult, ReadinessSnapshot } from './contracts.js';
import { detectPlatform } from './detect.js';
import { evaluateReadiness } from './readiness.js';

export interface DiagnosticReport {
  schemaVersion: 1;
  mode: 'DIAGNOSTIC_ONLY';
  liveProbesCollected: false;
  platform: PlatformDetection;
  capabilities: { apiRead: ReadinessResult; asideRead: ReadinessResult; screenCapture: ReadinessResult };
}
export interface DiagnosticPorts {
  read(): HostFacts;
  writeOut(text: string): void;
  writeError(text: string): void;
}
export function makeDiagnostic(facts: HostFacts): DiagnosticReport {
  const platform = detectPlatform(facts);
  const snapshot: ReadinessSnapshot = { host: platform, contextId: 'diagnostic-only', probes: {} };
  return {
    schemaVersion: 1, mode: 'DIAGNOSTIC_ONLY', liveProbesCollected: false, platform,
    capabilities: {
      apiRead: evaluateReadiness(snapshot, { kind: 'API_READ', auth: 'SERVICE' }, 0),
      asideRead: evaluateReadiness(snapshot, { kind: 'BROWSER_READ', provider: 'ASIDE' }, 0),
      screenCapture: evaluateReadiness(snapshot, { kind: 'SCREEN_CAPTURE' }, 0),
    },
  };
}
export function runDiagnostic(args: readonly string[], ports: DiagnosticPorts): number {
  if (args.length !== 1 || args[0] !== '--json') {
    ports.writeError('USAGE: gram-platform --json\n');
    return 64;
  }
  try {
    const report = makeDiagnostic(ports.read());
    ports.writeOut(`${JSON.stringify(report)}\n`);
    return report.platform.compatible ? 0 : 2;
  } catch {
    ports.writeError('DIAGNOSTIC_FAILED\n');
    return 70;
  }
}
