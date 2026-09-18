export interface WslPathRunner {
  run(args: readonly string[]): Promise<string>;
}

export class PathMapper {
  constructor(private readonly runner: WslPathRunner) {}

  async toWindows(linuxPath: string): Promise<string> {
    if (linuxPath.length === 0) throw new Error('Linux path must not be empty');

    const output = await this.runner.run(['-w', linuxPath]);
    const windowsPath = output.trim();
    if (windowsPath.length === 0) throw new Error('wslpath returned an empty Windows path');
    return windowsPath;
  }
}
