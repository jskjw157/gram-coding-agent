import type { CompletionStatus, DraftBundle } from './types.js';

export interface BundleWriterOptions {
  readonly remoteMutationPort?: { recordRemoteMutation(): void };
}

/** RED stub: throws on every call. */
export class BundleWriter {
  constructor(
    _dir: string,
    _opts?: BundleWriterOptions,
  ) {
    throw new Error('not implemented');
  }

  createRevision(_bundle: DraftBundle): { revisionId: string } {
    throw new Error('not implemented');
  }

  commitRevision(_revisionId: string): { bundlePath: string; completion: CompletionStatus } {
    throw new Error('not implemented');
  }

  recoverOrphans(): { recovered: number; cleaned: number } {
    throw new Error('not implemented');
  }
}
