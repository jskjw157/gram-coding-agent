// Destructive synthetic fixture setup ONLY in the disposable hosted CI VM.
// NEVER use this setup script to repair an actual installation. Production
// recovery lives in published-resume.ts and never resets private data.
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

if (
  process.env.GITHUB_ACTIONS !== 'true' ||
  !process.env.RUNNER_TEMP ||
  process.platform !== 'darwin' ||
  process.arch !== 'arm64' ||
  process.geteuid() !== 0
) {
  process.stderr.write('CI_ONLY\n');
  process.exit(77);
}
const expectedDigest = process.argv[2];
const expectedScope = process.argv[3];
if (
  process.argv.length !== 4 ||
  !/^[a-f0-9]{64}$/.test(expectedScope ?? '') ||
  !/^[a-f0-9]{64}$/.test(expectedDigest ?? '')
)
  process.exit(64);
const root = '/Library/Application Support/HAAR/GramAgent';
const config = JSON.parse(await readFile(`${root}/config/candidate-service.json`, 'utf8'));
if (
  config.releaseDigest !== expectedDigest ||
  config.tunnel?.enabled !== false ||
  !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(config.releaseId ?? '')
)
  throw new Error('INVALID_CI_RELEASE');
const release = `${root}/releases/${config.releaseId}`;
const base = pathToFileURL(`${release}/packages/macos-lifecycle/dist/`);
const load = (name) => import(new URL(name, base).href);
const [
  { createSystemBootstrapAclProbe },
  { createSystemNativeInstallStorage },
  { inspectMacAccount },
  { inspectMacRegistry, inspectMacPorts },
  files,
] = await Promise.all([
  load('a-system-sources.js'),
  load('a-native-storage.js'),
  load('adapters/macos-inspection.js'),
  load('adapters/macos-service-probes.js'),
  load('adapters/install-files.js'),
]);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
if (sha(await readFile(`${release}/release.json`)) !== expectedDigest) throw new Error('CI_RELEASE_DRIFT');
const acl = createSystemBootstrapAclProbe();
const storage = createSystemNativeInstallStorage(acl);
const account = await inspectMacAccount();
if (!account || account.admin || !account.groupsComplete) throw new Error('CI_ACCOUNT');
const receiptPath = `${root}/config/ci-owned-scope.json`;
const receiptStat = await lstat(receiptPath);
if (!receiptStat.isFile() || receiptStat.uid !== 0 || receiptStat.nlink !== 1 || (receiptStat.mode & 0o7777) !== 0o600)
  throw new Error('CI_SCOPE_METADATA');
const receiptBytes = await readFile(receiptPath);
if (sha(receiptBytes) !== expectedScope) throw new Error('CI_SCOPE_DIGEST');
const receipt = JSON.parse(receiptBytes);
if (
  receipt.schemaVersion !== 1 ||
  !/^[0-9]+$/.test(receipt.runId ?? '') ||
  receipt.runId !== process.env.GITHUB_RUN_ID ||
  receipt.runAttempt !== process.env.GITHUB_RUN_ATTEMPT ||
  receipt.runtimeUid !== account.uid ||
  receipt.releaseDigest !== expectedDigest ||
  typeof receipt.nonce !== 'string'
)
  throw new Error('CI_SCOPE_MISMATCH');
const before = await inspectMacRegistry();
const ports = await inspectMacPorts();
if (
  !before ||
  Object.values(before.jobs).some((value) => value !== 'absent') ||
  ports.core !== 'free' ||
  ports.tunnel !== 'free'
)
  throw new Error('CI_NOT_STOPPED');
for (const kind of ['configuration', 'manifest', 'journal', 'core', 'tunnel']) {
  if ((await storage.readLive(kind)) !== null || (await storage.publish.readStaged(kind)) !== null)
    throw new Error('CI_NOT_UNINSTALLED');
}
const layout = { anchor: '/', relative: root.slice(1), ownerUid: 0 };
const keyMetadata = async () => {
  const stat = await lstat(`${root}/secrets/mcp-internal-secret`, { bigint: true });
  if (
    !stat.isFile() ||
    stat.uid !== BigInt(account.uid) ||
    stat.gid !== BigInt(account.gid) ||
    stat.nlink !== 1n ||
    (stat.mode & 0o7777n) !== 0o600n
  )
    throw new Error('CI_KEY_METADATA');
  return [stat.dev, stat.ino, stat.uid, stat.gid, stat.mode, stat.size, stat.ctimeNs, stat.mtimeNs]
    .map((value) => value.toString())
    .join(':');
};
const keyBefore = await keyMetadata();
// This separate CI VM has just created the account/scope. Refuse any
// pre-existing private data; no private record or database reset is needed.
for (const name of ['run', 'state', 'logs']) {
  const path = `${root}/${name}`;
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.uid !== account.uid ||
    (stat.mode & 0o7777) !== 0o700 ||
    (await readdir(path)).length !== 0
  )
    throw new Error('CI_PRIVATE_NOT_EMPTY');
}
const configBytes = files.canonicalConfigBytes(config);
const core = files.expectedPlistBytes(config, 'core');
const manifest = files.buildManifest({
  runtime: { name: 'gram-agent', uid: account.uid, gid: account.gid },
  configBytes,
  releaseId: config.releaseId,
  releaseDigest: config.releaseDigest,
  corePlist: core,
  tunnelPlist: null,
});
for (const [kind, bytes] of [
  ['configuration', configBytes],
  ['core', core],
  ['manifest', manifest.bytes],
]) {
  await storage.publish.stageFile(kind, bytes);
  await storage.publish.publishFile(kind, bytes);
}
await storage.publish.stageFile('journal', files.buildCommittedJournal(manifest.bytes));
const published = files.buildIntermediateJournal('PUBLISHED', {
  previousDigest: null,
  nextDigest: manifest.sha,
  inventory: Object.values(files.FIXED_FILES),
});
await storage.journal.writeStage('PUBLISHED', published);
const { createSystemLaunchctlRunner } = await load('a-native-services.js');
const { launchctlVector } = await load('adapters/launchctl.js');
if ((await createSystemLaunchctlRunner()(launchctlVector('disable', 'core'))).code !== 0)
  throw new Error('CI_DISABLE_FAILED');
const childCode = await readFile(new URL('published-resume-prepare-only.mjs', import.meta.url), 'utf8');
const prepared = await new Promise((resolve) => {
  const child = execFile(
    '/usr/bin/sudo',
    [
      '-n',
      '-u',
      'gram-agent',
      '-g',
      'staff',
      '--',
      '/usr/bin/env',
      '-i',
      'GITHUB_ACTIONS=true',
      `RUNNER_TEMP=${process.env.RUNNER_TEMP}`,
      'PATH=/usr/bin:/bin:/usr/sbin:/sbin',
      'HOME=/var/empty',
      'USER=gram-agent',
      'LOGNAME=gram-agent',
      'LC_ALL=C',
      'LANG=C',
      `${release}/bin/node`,
      '--input-type=module',
      '-',
    ],
    {
      encoding: 'utf8',
      timeout: 85000,
      maxBuffer: 65536,
      shell: false,
      env: {
        GITHUB_ACTIONS: 'true',
        RUNNER_TEMP: process.env.RUNNER_TEMP,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: '/var/empty',
        USER: 'gram-agent',
        LOGNAME: 'gram-agent',
        LC_ALL: 'C',
        LANG: 'C',
      },
    },
    (error, stdout, stderr) => {
      try {
        const value = JSON.parse(stdout);
        process.stdout.write(
          'CI_PREPARE_DIAG ' +
            JSON.stringify({ prepared: value.prepared === true, exit: value.exit, commandOk: !error, ciGuard: false }) +
            '\n',
        );
        resolve(!error && value.prepared === true && value.exit === 0);
      } catch {
        process.stdout.write(
          'CI_PREPARE_DIAG ' +
            JSON.stringify({
              prepared: false,
              exit: Number.isInteger(error?.code) ? error.code : null,
              commandOk: !error,
              ciGuard: stderr.trim() === 'CI_ONLY',
            }) +
            '\n',
        );
        resolve(false);
      }
    },
  );
  child.stdin.on('error', () => {
    /* callback reports a bounded failed child */
  });
  child.stdin.end(childCode);
});
if (!prepared) throw new Error('CI_PREPARE_ONLY_FAILED');
const [{ createSystemFreshPublishedResumePorts }, { resumeFreshPublished }] = await Promise.all([
  load('a-published-resume-system.js'),
  load('published-resume.js'),
]);
// Deterministic pre-Core failure: the CI-only service fixture starts only a
// waiting sealed Node under the fixed label/UID, with the real native proof.
// No production prepare, Core, credential read, lease or DB mutation occurs.
const [{ createPublishedResumePortsAt }, { createSystemCoreStartAttempt }, { createSystemServiceHandle }] =
  await Promise.all([
    load('a-published-resume.js'),
    load('a-published-resume-system.js'),
    load('a-native-services.js'),
  ]);
const fixturePlist = `${root}/config/ci-waiting-supervisor.plist`;
const xml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
await writeFile(
  fixturePlist,
  `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>com.haar.gram-agent.core</string><key>UserName</key><string>gram-agent</string><key>GroupName</key><string>staff</string><key>ProgramArguments</key><array><string>${xml(release)}/bin/node</string><string>--input-type=module</string><string>-e</string><string>setInterval(() => {}, 1000)</string></array><key>RunAtLoad</key><true/><key>ExitTimeOut</key><integer>5</integer></dict></plist>`,
  { mode: 0o644, flag: 'wx' },
);
const launch = async (args) =>
  new Promise((resolve) =>
    execFile('/bin/launchctl', args, { encoding: 'utf8', timeout: 10000, maxBuffer: 65536, shell: false }, (error) =>
      resolve(!error),
    ),
  );
const actualServices = createSystemServiceHandle(acl);
let fixtureStarts = 0;
let fixtureStops = 0;
const pins = { manifestDigest: manifest.sha, journalDigest: sha(published), releaseDigest: expectedDigest };
const failurePorts = createPublishedResumePortsAt({
  layout,
  acl,
  storage,
  pins,
  account: inspectMacAccount,
  registry: inspectMacRegistry,
  ports: inspectMacPorts,
  authorizeLocalAdmin: async () => process.geteuid() === 0,
  proof: { capture: async () => null, current: async () => false },
  startAttempt: createSystemCoreStartAttempt(acl, expectedDigest),
  services: {
    ...actualServices,
    async start(role) {
      if (role !== 'core' || ++fixtureStarts !== 1) throw new Error('CI_FIXTURE_START_SCOPE');
      const ok =
        (await launch(['enable', 'system/com.haar.gram-agent.core'])) &&
        (await launch(['bootstrap', 'system', fixturePlist]));
      return { ok, code: ok ? 'OK' : 'PARTIAL_INSTALL' };
    },
    async stop(role) {
      if (role !== 'core' || ++fixtureStops !== 1) throw new Error('CI_FIXTURE_STOP_SCOPE');
      return actualServices.stop(role);
    },
    ownedHealthy: async () => false,
  },
});
const failureReview = await failurePorts.review();
if (!failureReview) throw new Error('CI_PRECORE_REVIEW');
const failureResult = await resumeFreshPublished(failureReview.transactionDigest, failurePorts);
if (
  failureResult.ok ||
  failureResult.code !== 'HEALTH_UNKNOWN' ||
  failureResult.stage !== 'PUBLISHED' ||
  failureResult.uncertain ||
  failureResult.compensationUnknown ||
  failureResult.lockUnknown ||
  fixtureStarts !== 1 ||
  fixtureStops !== 1
)
  throw new Error('CI_PRECORE_COMPENSATION');
if (
  !(await storage.journal.read())?.equals(published) ||
  !(await storage.publish.readStaged('journal'))?.equals(files.buildCommittedJournal(manifest.bytes)) ||
  (await keyMetadata()) !== keyBefore
)
  throw new Error('CI_PRECORE_CHANGED_DATA');
process.stdout.write('DISPOSABLE_PRECORE_NATIVE_COMPENSATION_PASS\n');
// New production factory instance on the same pristine records, no reset.
const resume = createSystemFreshPublishedResumePorts({
  manifestDigest: manifest.sha,
  journalDigest: sha(published),
  releaseDigest: expectedDigest,
});
const review = await resume.review();
if (!review) throw new Error('CI_PUBLISHED_REVIEW_FAILED');
const result = await resumeFreshPublished(review.transactionDigest, resume);
if (
  !result.ok ||
  result.code !== 'OK' ||
  result.stage !== 'COMMITTED' ||
  result.uncertain ||
  result.compensationUnknown ||
  result.lockUnknown
)
  throw new Error('CI_PUBLISHED_RESUME_FAILED');
if (
  !(await storage.journal.read())?.equals(files.buildCommittedJournal(manifest.bytes)) ||
  (await storage.publish.readStaged('journal')) !== null ||
  (await keyMetadata()) !== keyBefore
)
  throw new Error('CI_COMMIT_OR_KEY_DRIFT');
const after = await inspectMacRegistry();
const afterPorts = await inspectMacPorts();
if (
  !after ||
  after.jobs.core !== 'absent' ||
  after.jobs.tunnel !== 'absent' ||
  after.overrides.core !== true ||
  afterPorts.core !== 'free' ||
  afterPorts.tunnel !== 'free'
)
  throw new Error('CI_RESUME_NOT_PARKED');
process.stdout.write('DISPOSABLE_FRESH_PUBLISHED_RESUME_PASS\n');
