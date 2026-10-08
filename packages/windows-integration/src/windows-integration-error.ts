export type WindowsIntegrationErrorCode =
  'INVALID_OPERATION' | 'INVALID_PATH' | 'INVALID_URL' | 'NOT_DIRECTORY' | 'OPERATION_FAILED';

const messages: Record<WindowsIntegrationErrorCode, string> = {
  INVALID_OPERATION: 'Invalid fixed Windows operation.',
  INVALID_PATH: 'Invalid Windows Explorer path.',
  INVALID_URL: 'Invalid HTTP(S) URL for Windows Explorer.',
  NOT_DIRECTORY: 'Windows path opening requires an existing directory.',
  OPERATION_FAILED: 'Windows operation failed.',
};

export class WindowsIntegrationError extends Error {
  constructor(readonly code: WindowsIntegrationErrorCode) {
    super(messages[code]);
    this.name = 'WindowsIntegrationError';
  }
}

export function sanitizeWindowsFailure(error: unknown): WindowsIntegrationError {
  // Recreate even our own errors: injected implementations may attach private details.
  if (error instanceof WindowsIntegrationError && Object.hasOwn(messages, error.code)) {
    return new WindowsIntegrationError(error.code);
  }
  return new WindowsIntegrationError('OPERATION_FAILED');
}
