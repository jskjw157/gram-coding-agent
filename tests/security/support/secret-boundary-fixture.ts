import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  CommandRunRepository,
  openDatabase,
  runMigrations,
  TaskRepository,
} from '@gram/persistence';
import { normalizeExecutableCommand, PolicyEngine } from '@gram/policy';
import { FileSecretProvider, SecretRedactor, type SecretProvider } from '@gram/secrets';
import { CommandRunner, NodeProcessSpawner, OutputCapture } from '@gram/shell';

export type ProbeRoute = 'direct' | 'descendant' | 'npm-test';
type CredentialLabel = 'github' | 'tunnel' | 'mcp';

interface ReadAttempt {
  readSucceeded: boolean;
  canaryMatched: boolean;
  errorCode: string | null;
}

export interface ProbeReport {
  schema: string;
  challenge: string;
  stage: ProbeRoute;
  pid: number;
  ppid: number;
  uid: number;
  euid: number;
  capEff: string;
  environment: Record<string, boolean>;
  reads: Record<CredentialLabel, ReadAttempt>;
  permissionControl: ReadAttempt;
  npmLifecycle: string | null;
  launcher?: { pid: number; uid: number; euid: number };
}

const credentials = [
  { label: 'github', name: 'github-token' },
  { label: 'tunnel', name: 'tunnel-runtime-key' },
  { label: 'mcp', name: 'mcp-internal-secret' },
] as const;

const marker = 'GRAM_SECRET_BOUNDARY_PROBE=';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function createSecretBoundaryFixture() {
  assert.equal(process.platform, 'linux', 'This suite requires the Linux process/filesystem boundary');
  assert.equal(process.getuid?.(), process.geteuid?.(), 'Do not run the fixture with setuid authority');
  // A root UID in a restricted container is not by itself DAC bypass. Check the
  // actual capability bits AND require a mode-0000 denial in every real child.
  const status = readFileSync('/proc/self/status', 'utf8');
  const capEff = /^CapEff:\s+([0-9a-f]+)$/m.exec(status)?.[1];
  assert.ok(capEff, 'Linux capability metadata is required');
  assert.equal(BigInt('0x' + capEff) & 6n, 0n, 'Run without CAP_DAC_OVERRIDE / CAP_DAC_READ_SEARCH');

  // Intentionally do not use homedir(), the host TMPDIR, or a real secret path.
  const root = mkdtempSync('/tmp/gram-secret-boundary-');
  const home = path.join(root, 'agent-home');
  const secretDirectory = path.join(home, '.gram-agent', 'secrets');
  const temp = path.join(root, 'tmp');
  const bin = path.join(root, 'bin');
  for (const directory of [home, secretDirectory, temp, bin]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const db = openDatabase(path.join(root, 'state.db'));
  function dispose() {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }

  try {
    runMigrations(db);
    const task = new TaskRepository(db).create({
      goal: 'Synthetic credential boundary regression only',
      taskType: 'CODING',
      publishMode: 'PULL_REQUEST',
    });
    const worktree = path.join(home, '.gram-agent', 'worktrees', '1', task.id);
    mkdirSync(worktree, { recursive: true, mode: 0o700 });
    const commandRuns = new CommandRunRepository(db);
    const provider: SecretProvider = new FileSecretProvider(secretDirectory);
    const fakeValues = {
      github: 'fake-only-github-' + randomUUID(),
      tunnel: 'fake-only-tunnel-' + randomUUID(),
      mcp: 'fake-only-mcp-' + randomUUID(),
    };
    const seededEnvironment = {
      GITHUB_TOKEN: fakeValues.github,
      GH_TOKEN: fakeValues.github,
      CONTROL_PLANE_API_KEY: fakeValues.tunnel,
      GRAM_MCP_INTERNAL_SECRET: fakeValues.mcp,
      OPENAI_ADMIN_KEY: 'fake-only-admin-env-' + randomUUID(),
    };
    const manifestCredentials = [];
    for (const credential of credentials) {
      const file = path.join(secretDirectory, credential.name);
      // No newline: the provider's string and the actual file have identical bytes.
      writeFileSync(file, fakeValues[credential.label], { mode: 0o600, flag: 'wx' });
      chmodSync(file, 0o600);
      const stat = lstatSync(file);
      assert.ok(stat.isFile() && !stat.isSymbolicLink());
      assert.equal(stat.mode & 0o777, 0o600);
      assert.equal(stat.uid, process.getuid?.());
      assert.ok(!file.startsWith(worktree + path.sep));
      const lease = await provider.getForUse(credential.name);
      let registeredDigest: string;
      try {
        // Boolean comparisons keep even synthetic canaries out of failure output.
        assert.ok(lease.withValue((value) => value === fakeValues[credential.label]),
          'Real SecretProvider must lease the exact fake file before the attack');
        registeredDigest = lease.withValue(digest);
      } finally {
        lease.dispose();
      }
      assert.throws(() => lease.withValue(() => undefined), /disposed/i);
      manifestCredentials.push({
        label: credential.label,
        relativePath: path.relative(root, file),
        digest: registeredDigest,
      });
    }
    assert.equal(lstatSync(root).mode & 0o777, 0o700);
    assert.equal(lstatSync(secretDirectory).mode & 0o777, 0o700);

    const permissionControl = path.join(root, 'mode-0000-control');
    writeFileSync(permissionControl, 'non-secret permission control', { mode: 0o000, flag: 'wx' });
    chmodSync(permissionControl, 0o000);
    assert.throws(() => readFileSync(permissionControl), { code: 'EACCES' });

    // Pin real installed executables; the policy request still uses literal
    // node/npm. A script that merely pretends to be npm would not test npm.
    symlinkSync(process.execPath, path.join(bin, 'node'));
    const npmCli = realpathSync(path.join(path.dirname(process.execPath), 'npm'));
    symlinkSync(npmCli, path.join(bin, 'npm'));
    copyFileSync(new URL('./secret-boundary-probe.mjs', import.meta.url),
      path.join(worktree, 'secret-boundary-probe.mjs'));
    const challenge = randomUUID();
    writeFileSync(path.join(worktree, 'secret-boundary-manifest.json'), JSON.stringify({
      schema: 'gram-secret-boundary-fixture/v1',
      root,
      worktree,
      challenge,
      credentials: manifestCredentials,
      permissionControl: path.relative(root, permissionControl),
    }), { mode: 0o600 });
    writeFileSync(path.join(worktree, 'package.json'), JSON.stringify({
      name: 'gram-secret-boundary-fixture',
      version: '0.0.0',
      private: true,
      scripts: { test: 'node ./secret-boundary-probe.mjs npm-test' },
    }), { mode: 0o600 });
    const npmUserConfig = path.join(root, 'npm-user-empty.conf');
    const npmGlobalConfig = path.join(root, 'npm-global-empty.conf');
    writeFileSync(npmUserConfig, '', { mode: 0o600 });
    writeFileSync(npmGlobalConfig, '', { mode: 0o600 });
    const environment = {
      PATH: bin + ':/usr/bin:/bin',
      HOME: home,
      TMPDIR: temp,
      TMP: temp,
      TEMP: temp,
      XDG_RUNTIME_DIR: temp,
      LANG: 'C.UTF-8',
      ...seededEnvironment,
    };
    const policy = new PolicyEngine();
    let approvalRequests = 0;
    const runner = new CommandRunner({
      policy,
      approvals: {
        consume: async () => {
          approvalRequests += 1;
          throw new Error('The fixture grants no extra authority or credential access');
        },
      },
      spawner: new NodeProcessSpawner(),
      commandRuns,
      outputCapture: new OutputCapture({
        homeDir: home,
        redactor: new SecretRedactor(Object.values(seededEnvironment)),
      }),
      homeDir: home,
      environment,
    });

    return {
      dispose,
      async observe(route: ProbeRoute) {
        const executable = route === 'npm-test' ? 'npm' : 'node';
        const args = route === 'npm-test'
          ? [
              'test', '--silent', '--offline', '--no-audit', '--no-fund', '--no-update-notifier',
              '--userconfig=' + npmUserConfig,
              '--globalconfig=' + npmGlobalConfig,
              '--cache=' + path.join(root, 'npm-cache'),
              '--script-shell=/bin/sh',
            ]
          : ['secret-boundary-probe.mjs', route === 'descendant' ? 'descendant-parent' : 'direct'];
        const decision = policy.evaluate(normalizeExecutableCommand(executable, args, worktree),
          { taskId: task.id });
        assert.equal(decision.kind, 'ALLOW', 'The probe must exercise an ordinary allowed command');
        const result = await runner.run({
          taskId: task.id,
          cwd: worktree,
          category: 'VERIFICATION',
          executable,
          args,
        });
        assert.equal(result.exitCode, 0, 'The real command must execute successfully');
        const lines = result.stdout.split('\n').filter((line) => line.startsWith(marker));
        assert.equal(lines.length, 1, 'Exactly one real-process handshake is required');
        const line = lines[0];
        assert.ok(line);
        const report = JSON.parse(line.slice(marker.length)) as ProbeReport;
        assert.equal(report.schema, 'gram-secret-boundary-probe/v1');
        assert.equal(report.challenge, challenge);
        assert.equal(report.stage, route);
        assert.ok(Number.isInteger(report.pid) && report.pid !== process.pid);
        assert.equal(BigInt('0x' + report.capEff) & 6n, 0n, 'Child must lack DAC-bypass capabilities');
        assert.deepEqual(report.permissionControl, {
          readSucceeded: false, canaryMatched: false, errorCode: 'EACCES',
        }, 'Mode-0000 control must be denied; root privilege must not explain a canary read');
        assert.deepEqual(Object.keys(report.reads).sort(), ['github', 'mcp', 'tunnel']);
        for (const credential of credentials) {
          const attempted = report.reads[credential.label];
          assert.equal(typeof attempted.readSucceeded, 'boolean');
          if (attempted.readSucceeded) {
            assert.equal(attempted.canaryMatched, true, 'The read must match the provider-backed fake canary');
            assert.equal(attempted.errorCode, null);
          } else {
            assert.equal(attempted.canaryMatched, false);
            assert.ok(['EACCES', 'EPERM'].includes(attempted.errorCode ?? ''),
              'Missing files and probe/setup failures are not security denials');
          }
        }
        if (route === 'descendant') {
          assert.ok(report.launcher, 'A real second-generation child is required');
          assert.notEqual(report.pid, report.launcher.pid);
          assert.equal(report.ppid, report.launcher.pid);
        }
        if (route === 'npm-test') assert.equal(report.npmLifecycle, 'test');
        assert.equal(approvalRequests, 0);
        const row = commandRuns.get(result.commandRunId);
        assert.equal(row?.status, 'SUCCEEDED');
        assert.equal(row.exitCode, 0);
        const retainedEvidence = JSON.stringify({
          result,
          row,
          stdoutLog: readFileSync(result.stdoutPath, 'utf8'),
          stderrLog: readFileSync(result.stderrPath, 'utf8'),
        });
        for (const fakeValue of Object.values(seededEnvironment)) {
          assert.ok(!retainedEvidence.includes(fakeValue), 'Fixture evidence must not contain canary values');
        }
        // Observation only: a later production fix may deliberately change UID.
        const evidence = {
          route,
          providerCanariesVerified: credentials.length,
          fileMode: '0600',
          agentUid: process.getuid?.(),
          childUid: report.uid,
          childEuid: report.euid,
          capEff: report.capEff,
          policy: decision.kind,
          approvalRequests,
          commandStatus: row.status,
          exitCode: result.exitCode,
          environment: report.environment,
          reads: report.reads,
          permissionControl: report.permissionControl.errorCode,
          npmLifecycle: report.npmLifecycle,
          descendantExecuted: report.launcher !== undefined,
          retainedCanaryValues: false,
        };
        return { report, evidence };
      },
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
