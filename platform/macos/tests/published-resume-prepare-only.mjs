// Invoked over stdin only by disposable hosted CI, never an installation repair.
import { pathToFileURL } from 'node:url';
if (
  process.env.GITHUB_ACTIONS !== 'true' ||
  !process.env.RUNNER_TEMP ||
  process.platform !== 'darwin' ||
  process.arch !== 'arm64' ||
  process.getuid() === 0 ||
  !/^\/Library\/Application Support\/HAAR\/GramAgent\/releases\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/bin\/node$/.test(
    process.execPath,
  )
) {
  process.stderr.write('CI_ONLY\n');
  process.exit(77);
}
const base = new URL('../packages/macos-lifecycle/dist/', pathToFileURL(process.execPath));
const [{ createASystemSupervisorBootstrapFromFixedSources }, { runSupervisorEntry }] = await Promise.all([
  import(new URL('a-bootstrap.js', base)),
  import(new URL('supervisor-entry.js', base)),
]);
const bootstrap = createASystemSupervisorBootstrapFromFixedSources();
let prepared = false;
const exit = await runSupervisorEntry(
  ['--role', 'core', '--config', '/Library/Application Support/HAAR/GramAgent/config/service.json'],
  {
    async prepare(invocation, signal) {
      const session = await bootstrap.prepare(invocation, signal);
      prepared = session !== null;
      return session
        ? {
            async run() {
              return 0;
            },
          }
        : null;
    },
  },
  { on() {}, removeListener() {} },
);
process.stdout.write(JSON.stringify({ prepared, exit, credentialsUsed: false }));
process.exitCode = exit === 0 && prepared ? 0 : 2;
