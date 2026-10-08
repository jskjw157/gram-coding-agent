export interface WindowsPathInvocation {
  readonly executable: 'wslpath';
  readonly args: readonly ['-w' | '-u', string];
}

export interface WindowsPathRunner {
  run(request: WindowsPathInvocation): Promise<string>;
}

export class WindowsPathService {
  constructor(private readonly runner: WindowsPathRunner) {}

  toWindows(linuxPath: string): Promise<string> {
    return this.convert('-w', linuxPath);
  }

  toLinux(windowsPath: string): Promise<string> {
    return this.convert('-u', windowsPath);
  }

  private async convert(direction: '-w' | '-u', path: string): Promise<string> {
    const output = await this.runner.run({ executable: 'wslpath', args: [direction, path] });
    return output.replace(/\r?\n$/, '');
  }
}
