import { LocalWorkSession, type LocalWorkOptions } from './session.js';

type LocalOperation =
  | { op: 'read_text'; path: string }
  | { op: 'write_text'; path: string; content: string }
  | { op: 'run_node'; path: string; args: string[] };

function operationsFrom(input: unknown): LocalOperation[] {
  if (
    input === null ||
    typeof input !== 'object' ||
    !('operations' in input) ||
    !Array.isArray(input.operations) ||
    input.operations.length < 1 ||
    input.operations.length > 100
  )
    throw new Error('Expected 1–100 local operations');
  return input.operations.map((value: unknown) => {
    if (
      value === null ||
      typeof value !== 'object' ||
      !('op' in value) ||
      !('path' in value) ||
      typeof value.path !== 'string'
    )
      throw new Error('Invalid local operation');
    if (value.op === 'read_text') return { op: value.op, path: value.path };
    if (value.op === 'write_text' && 'content' in value && typeof value.content === 'string')
      return { op: value.op, path: value.path, content: value.content };
    if (value.op === 'run_node') {
      const args: unknown = 'args' in value ? value.args : [];
      if (Array.isArray(args) && args.every((arg: unknown) => typeof arg === 'string'))
        return { op: value.op, path: value.path, args };
    }
    throw new Error('Invalid local operation');
  });
}

export async function runLocalJob(input: unknown, options: LocalWorkOptions) {
  const operations = operationsFrom(input);
  if (operations.some((operation) => operation.op === 'run_node') && options.trustedLocalCode !== true)
    throw new Error('Execution requires explicit trusted local code opt-in');
  const session = new LocalWorkSession(options);
  const results: Array<Record<string, unknown>> = [];
  for (const operation of operations) {
    switch (operation.op) {
      case 'read_text':
        results.push({ op: operation.op, content: session.readText(operation.path) });
        break;
      case 'write_text':
        session.writeText(operation.path, operation.content);
        results.push({ op: operation.op, written: true });
        break;
      case 'run_node':
        results.push({ op: operation.op, ...(await session.runNode(operation.path, operation.args)) });
        break;
    }
  }
  return { executionIsolation: 'HOST_PROCESS_NOT_OS_SANDBOXED' as const, results, runs: session.history() };
}
