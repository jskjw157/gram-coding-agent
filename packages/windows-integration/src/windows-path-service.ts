export interface WindowsPathInvocation {
  readonly executable: 'wslpath';
  readonly args: readonly ['-w' | '-u', string];
}

export interface WindowsPathRunner {
  run(request: WindowsPathInvocation): Promise<string>;
}

export class WindowsPathService {
  constructor(private readonly runner: WindowsPathRunner) {}

  async toWindows(linuxPath: string): Promise<string> {
    void linuxPath;
    throw new Error('Not implemented');
  }

  async toLinux(windowsPath: string): Promise<string> {
    void windowsPath;
    throw new Error('Not implemented');
  }
}
