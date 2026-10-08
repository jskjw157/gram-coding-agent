import { FixedWindowsRunner, type WindowsOperationRunner } from './fixed-windows-runner.js';

export class WindowsRevealService {
  constructor(private readonly runner: WindowsOperationRunner = new FixedWindowsRunner()) {}

  async revealPath(windowsPath: string): Promise<void> {
    void windowsPath;
    throw new Error('NOT_IMPLEMENTED');
  }
}
