// operations-composition.ts — FIXTURE-profile operations composition
// (MAC-03 WP-12, decision D11).
//
// Wires the single-engine workflow runner + artifact store + MCP operation
// tools behind an explicit FIXTURE profile flag. Any other profile — including
// DISABLED and anything resembling production — is refused with
// ProductionProfileRefusedError. This module never reads the environment
// itself; use resolveOperationsProfile to map env -> profile, and construct the
// real runner/artifacts/tools at the call site (kept dependency-free so this
// file adds no workspace imports; main.ts is untouched).
//
// LAB_ONLY note: agent_health behavior is unchanged by this composition.

export type OperationsProfile = 'FIXTURE' | 'DISABLED';

export const FIXTURE_OPERATIONS_PROFILE = 'FIXTURE' as const;

export class ProductionProfileRefusedError extends Error {
  override name = 'ProductionProfileRefusedError';
}

export interface OperationsToolLike {
  readonly name: string;
}

export interface FixtureOperationsDependencies<
  Runner,
  Artifacts,
  Tool extends OperationsToolLike,
> {
  readonly profile: string;
  readonly runner: Runner;
  readonly artifacts: Artifacts;
  readonly tools: readonly Tool[];
}

export interface ComposedFixtureOperations<
  Runner,
  Artifacts,
  Tool extends OperationsToolLike,
> {
  readonly profile: typeof FIXTURE_OPERATIONS_PROFILE;
  readonly runner: Runner;
  readonly artifacts: Artifacts;
  readonly tools: readonly Tool[];
}

/**
 * Map environment to an operations profile. FIXTURE is enabled ONLY on the
 * explicit opt-in value 'FIXTURE'; every other value (absent, production-like,
 * or unknown) resolves to DISABLED. Production is never auto-enabled.
 */
export const resolveOperationsProfile = (
  env: Record<string, string | undefined>,
): OperationsProfile => (env['GRAM_OPERATIONS_PROFILE'] === 'FIXTURE' ? 'FIXTURE' : 'DISABLED');

/**
 * Wire runner + artifacts + tools under the FIXTURE profile. Refuses to
 * compose anything else — callers must gate on resolveOperationsProfile first.
 */
export const composeFixtureOperations = <
  Runner,
  Artifacts,
  Tool extends OperationsToolLike,
>(
  dependencies: FixtureOperationsDependencies<Runner, Artifacts, Tool>,
): ComposedFixtureOperations<Runner, Artifacts, Tool> => {
  if (dependencies.profile !== FIXTURE_OPERATIONS_PROFILE) {
    throw new ProductionProfileRefusedError(
      `operations composition runs under FIXTURE only (requested: ${dependencies.profile})`,
    );
  }
  return {
    profile: FIXTURE_OPERATIONS_PROFILE,
    runner: dependencies.runner,
    artifacts: dependencies.artifacts,
    tools: [...dependencies.tools],
  };
};
