import { FixedWindowsRunner, type WindowsOperationRunner } from './fixed-windows-runner.js';
import { sanitizeWindowsFailure } from './windows-integration-error.js';
import { normalizeHttpUrl, validateWindowsPath } from './windows-targets.js';

export class WindowsOpenService {
  constructor(private readonly runner: WindowsOperationRunner = new FixedWindowsRunner()) {}

  async openPath(windowsPath: string): Promise<void> {
    const target = validateWindowsPath(windowsPath);
    try {
      await this.runner.run({ kind: 'OPEN_PATH', windowsPath: target });
    } catch (error) {
      throw sanitizeWindowsFailure(error);
    }
  }

  async openUrl(url: string): Promise<void> {
    const target = normalizeHttpUrl(url);
    try {
      await this.runner.run({ kind: 'OPEN_URL', url: target });
    } catch (error) {
      throw sanitizeWindowsFailure(error);
    }
  }
}
