import type { Preview, SafeCode, ServiceConfig } from './contracts.js';
import type { Inspector, PreflightFacts } from './inspection-contracts.js';

// Deliberately nonimplementing TDD scaffolds until assertion RED is observed.
export function firstRefusal(facts: PreflightFacts): SafeCode {
  void facts;
  return 'INTERNAL_ERROR';
}
export async function preview(config: ServiceConfig, expectedDigest: string, inspector: Inspector): Promise<Preview> {
  void config; void expectedDigest; void inspector;
  return { ok: false, code: 'INTERNAL_ERROR', configDigest: '', previousInstallDigest: null,
    releaseDigest: '', roles: [] };
}
