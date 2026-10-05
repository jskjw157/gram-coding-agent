import process from 'node:process';
import { runDiagnostic } from './diagnostic.js';
import { readHostFacts } from './host-facts.js';

process.exitCode = runDiagnostic(process.argv.slice(2), {
  read: readHostFacts,
  writeOut: (text) => { process.stdout.write(text); },
  writeError: (text) => { process.stderr.write(text); },
});
