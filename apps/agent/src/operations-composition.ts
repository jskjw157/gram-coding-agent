// operations-composition.ts — FIXTURE-profile operations composition
// (T10 repair: the standalone WorkflowRunner wiring is deleted; this module
// composes the M2-backed OperationsDispatch — M2 TaskService / TaskRunner /
// state machine under T4 lease semantics,
// packages/task-engine/src/operations-delegation.ts — with the artifact
// store and MCP operation tools as thin adapters).
//
// Wires the M2-backed dispatch + artifact store + MCP operation tools behind
// an explicit FIXTURE profile flag. Any other profile — including DISABLED
// and anything resembling production — is refused with
// ProductionProfileRefusedError. This module never reads the environment
// itself; use resolveOperationsProfile to map env -> profile, and construct
// the real dispatch/artifacts/tools at the call site (kept dependency-free
// so this file adds no workspace imports; main.ts is untouched).
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

/**
 * Structural minimum of OperationsDispatch the composition delegates to.
 * Execution lives in the M2-backed dispatch; this composition only wires it.
 */
export interface OperationsDispatchLike {
  create(input: { readonly repo: string; readonly goal: string }): Promise<unknown>;
  run(taskId: string, requester: string): Promise<unknown>;
}

export interface FixtureOperationsDependencies<
  Dispatch extends OperationsDispatchLike,
  Artifacts,
  Tool extends OperationsToolLike,
> {
  readonly profile: string;
  readonly dispatch: Dispatch;
  readonly artifacts: Artifacts;
  readonly tools: readonly Tool[];
}

export interface ComposedFixtureOperations<
  Dispatch extends OperationsDispatchLike,
  Artifacts,
  Tool extends OperationsToolLike,
> {
  readonly profile: typeof FIXTURE_OPERATIONS_PROFILE;
  readonly dispatch: Dispatch;
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
 * Wire the M2-backed dispatch + artifacts + tools under the FIXTURE profile.
 * Refuses to compose anything else — callers must gate on
 * resolveOperationsProfile first.
 */
export const composeFixtureOperations = <
  Dispatch extends OperationsDispatchLike,
  Artifacts,
  Tool extends OperationsToolLike,
>(
  dependencies: FixtureOperationsDependencies<Dispatch, Artifacts, Tool>,
): ComposedFixtureOperations<Dispatch, Artifacts, Tool> => {
  if (dependencies.profile !== FIXTURE_OPERATIONS_PROFILE) {
    throw new ProductionProfileRefusedError(
      `operations composition runs under FIXTURE only (requested: ${dependencies.profile})`,
    );
  }
  return {
    profile: FIXTURE_OPERATIONS_PROFILE,
    dispatch: dependencies.dispatch,
    artifacts: dependencies.artifacts,
    tools: [...dependencies.tools],
  };
};
