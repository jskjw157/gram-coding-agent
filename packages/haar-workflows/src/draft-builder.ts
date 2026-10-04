import type { DraftBundle, ProductDraftInput, StepKey, StepReadiness, StepResult } from './types.js';

export interface DraftBuilderOptions {
  readonly remoteMutationPort?: { recordRemoteMutation(): void };
}

/** RED stub: throws on every call. */
export class DraftBuilder {
  static readonly stepKeys: readonly StepKey[] = ['source', 'assets', 'copy', 'render', 'recheck', 'bundle'];

  constructor(_opts?: DraftBuilderOptions) {
    throw new Error('not implemented');
  }

  runStep(_stepKey: string, _input: ProductDraftInput): StepResult {
    throw new Error('not implemented');
  }

  readiness(_stepKey: StepKey, _input: ProductDraftInput): StepReadiness {
    throw new Error('not implemented');
  }

  finalizeBundle(_input: ProductDraftInput): DraftBundle {
    throw new Error('not implemented');
  }
}
