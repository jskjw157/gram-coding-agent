import { FixedWindowsRunner, type WindowsOperationRunner } from './fixed-windows-runner.js';

export class WindowsOpenService {
  constructor(private readonly runner: WindowsOperationRunner = new FixedWindowsRunner()) {}

  async openPath(windowsPath: string): Promise<void> {
    void windowsPath;
    throw new Error('NOT_IMPLEMENTED');
  }

  async openUrl(url: string): Promise<void> {
    void url;
    throw new Error('NOT_IMPLEMENTED');
  }
}
