import { pathToFileURL } from 'node:url';
import { SecretRedactor } from '@gram/secrets';
import { runLocalJob } from './job.js';

export async function main(args: readonly string[], signal?: AbortSignal): Promise<number> {
  let workspace: string | undefined;
  let trustedLocalCode = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--workspace' && workspace === undefined && args[i + 1] !== undefined) workspace = args[++i];
    else if (arg === '--trusted-local-code' && !trustedLocalCode) trustedLocalCode = true;
    else throw new Error('Usage: work --workspace DIR [--trusted-local-code] < job.json');
  }
  if (workspace === undefined) throw new Error('An explicit --workspace DIR is required');
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const value of process.stdin) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as string);
    bytes += chunk.length;
    if (bytes > 1_048_576) throw new Error('Local job exceeds 1 MiB');
    chunks.push(chunk);
  }
  let input: unknown;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Invalid local job JSON');
  }
  if (signal?.aborted) throw new Error('Local execution cancelled');
  const result = await runLocalJob(input, { workspace, trustedLocalCode, ...(signal === undefined ? {} : { signal }) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.runs.some((run) => run.status !== 'SUCCEEDED') ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  let signalExitCode: number | undefined;
  const interrupt = () => {
    signalExitCode = 130;
    controller.abort();
    process.stdin.destroy(new Error('Local execution cancelled'));
  };
  const terminate = () => {
    signalExitCode = 143;
    controller.abort();
    process.stdin.destroy(new Error('Local execution cancelled'));
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  main(process.argv.slice(2), controller.signal)
    .then((code) => {
      process.exitCode = signalExitCode ?? code;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Local job failed';
      process.stderr.write(`${JSON.stringify({ error: new SecretRedactor().redact(message) })}\n`);
      process.exitCode = signalExitCode ?? 1;
    })
    .finally(() => {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', terminate);
    });
}
