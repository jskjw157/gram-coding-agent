import { FixedWindowsRunner, type WindowsOperationRunner } from './fixed-windows-runner.js';
import { sanitizeWindowsFailure } from './windows-integration-error.js';
import { validateWindowsPath } from './windows-targets.js';

export class WindowsRevealService {
  constructor(private readonly runner: WindowsOperationRunner = new FixedWindowsRunner()) {}

  async revealPath(windowsPath: string): Promise<void> {
    const target = validateWindowsPath(windowsPath);
    try {
      await this.runner.run({ kind: 'REVEAL_PATH', windowsPath: target });
    } catch (error) {
      throw sanitizeWindowsFailure(error);
    }
  }
}
