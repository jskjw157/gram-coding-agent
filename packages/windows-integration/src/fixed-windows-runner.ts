export type FixedWindowsOperation =
  | { readonly kind: 'OPEN_PATH'; readonly windowsPath: string }
  | { readonly kind: 'REVEAL_PATH'; readonly windowsPath: string }
  | { readonly kind: 'OPEN_URL'; readonly url: string };

export interface WindowsOperationRunner {
  run(operation: FixedWindowsOperation): Promise<void>;
}

export class FixedWindowsRunner implements WindowsOperationRunner {
  async run(operation: FixedWindowsOperation): Promise<void> {
    void operation;
    throw new Error('NOT_IMPLEMENTED');
  }
}
