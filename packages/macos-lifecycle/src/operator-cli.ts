import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCli } from './cli.js';
import { createSystemOperatorCliDeps } from './a-operator.js';

export function isDirectOperatorCli(moduleUrl: string, argv1: string | undefined): boolean {
  try {
    if (typeof argv1 !== 'string' || !isAbsolute(argv1)) return false;
    return pathToFileURL(resolve(argv1)).href === new URL(moduleUrl).href;
  } catch { return false; }
}

export async function runSystemOperatorCli(argv: readonly string[]): Promise<number> {
  return runCli(argv, createSystemOperatorCliDeps(line => { process.stdout.write(line); }));
}

if (isDirectOperatorCli(import.meta.url, process.argv[1])) {
  void runSystemOperatorCli(process.argv.slice(2)).then(
    code => { process.exitCode = code; },
    () => { process.exitCode = 70; },
  );
}

