import { constants, type BigIntStats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { LocalAccount } from './adapters/macos-inspection.js';
import type { RegistryObservation, PortState } from './adapters/macos-service-probes.js';
import { inspectRuntimeDirectories, type RuntimeLayout } from './adapters/runtime-directories.js';
import { createTrustedFiles, type AclProbe } from './adapters/trusted-files.js';
import { createExecutionFilesAt } from './adapters/execution-files.js';
import { createCoreProcessFilesAt } from './adapters/core-process-files.js';
import { createTelemetryFilesAt } from './adapters/telemetry-files.js';
import { createRuntimeStores } from './adapters/runtime-stores.js';
import { ExecutionLeaseStore, encodeExecution } from './execution-lease.js';
import { parseConfig } from './config.js';
import type { NativeInstallStorage } from './a-native-storage.js';
import type { PublishKind, ServiceHandle } from './installation-transaction/contracts.js';
import type { FreshPublishedResumePorts } from './published-resume.js';
import {
  buildCommittedJournal,
  buildIntermediateJournal,
  buildManifest,
  canonicalConfigBytes,
  expectedPlistBytes,
  FIXED_FILES,
  shaBytes,
} from './adapters/install-files.js';
import { inspectRelease } from './release-inspection.js';
import { waitForResumeIdle } from './resume-idle.js';
import { RELEASE_REVIEW_TIMEOUT_MS } from './release-review-budget.js';

export interface PublishedResumePins {
  manifestDigest: string;
  journalDigest: string;
  releaseDigest: string;
}
/** Trusted internal composition/fixture seam, never CLI/config/MCP input. */
export interface PublishedResumeOptions {
  layout: RuntimeLayout;
  acl: AclProbe;
  storage: NativeInstallStorage;
  pins: PublishedResumePins;
  account(): Promise<LocalAccount | null>;
  registry(): Promise<RegistryObservation | null>;
  ports(): Promise<{ core: PortState; tunnel: PortState }>;
  authorizeLocalAdmin(): Promise<boolean>;
  services: ServiceHandle;
  proof: { capture(): Promise<string | null>; current(pin: string, expected: 'OWNED' | 'FOREIGN'): Promise<boolean> };
  startAttempt: {
    capture(): Promise<string | null>;
    current(pin: string, expected: 'OWNED' | 'FOREIGN'): Promise<boolean>;
  };
}
const kinds: readonly PublishKind[] = ['configuration', 'manifest', 'journal', 'core', 'tunnel'];
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function refuse(): never {
  throw new Error('PARTIAL_INSTALL');
}
function same(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.uid === b.uid &&
    a.gid === b.gid &&
    a.mode === b.mode &&
    a.nlink === b.nlink &&
    a.size === b.size &&
    a.ctimeNs === b.ctimeNs &&
    a.mtimeNs === b.mtimeNs
  );
}
interface Snapshot {
  live: Record<PublishKind, Buffer | null>;
  staged: Record<PublishKind, Buffer | null>;
  key: string;
  registry: RegistryObservation;
  account: LocalAccount;
}
/** Only a pristine, fixed Core-only first install is eligible. Existing apply
 * and control keep their partial-install refusal. Root/admin remains trusted;
 * the install lock provides cooperative exclusion, not atomic exclusion of root.
 */
export function createPublishedResumePortsAt(input: PublishedResumeOptions): FreshPublishedResumePorts {
  const options = { ...input, pins: { ...input.pins }, layout: { ...input.layout } };
  let approved: { snapshot: Snapshot; token: string; records: string; started: Buffer; committed: Buffer } | null =
    null;
  let requested = false;
  let stopAttempted = false;
  let ownedPin: string | null = null;
  let attemptPin: string | null = null;
  const { storage, acl, layout } = options;
  async function keyMetadata(account: LocalAccount): Promise<string> {
    const directories = await inspectRuntimeDirectories(layout, account.uid, acl, new AbortController().signal);
    await directories.verify();
    const path = join(layout.anchor, layout.relative, 'secrets/mcp-internal-secret');
    const before = await lstat(path, { bigint: true });
    if (
      !before.isFile() ||
      before.uid !== BigInt(account.uid) ||
      before.gid !== BigInt(account.gid) ||
      before.nlink !== 1n ||
      (before.mode & 0o7777n) !== 0o600n ||
      before.size < 1n ||
      before.size > 65536n
    )
      refuse();
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (
        !same(before, await file.stat({ bigint: true })) ||
        (await acl(file)) !== true ||
        !same(before, await file.stat({ bigint: true })) ||
        !same(before, await lstat(path, { bigint: true }))
      )
        refuse();
      await directories.verify();
      // Metadata only. Neither read()/readFile() nor credential use is allowed.
      return JSON.stringify(
        [
          before.dev,
          before.ino,
          before.uid,
          before.gid,
          before.mode,
          before.nlink,
          before.size,
          before.mtimeNs,
          before.ctimeNs,
        ].map((value) => value.toString()),
      );
    } finally {
      await file.close().catch(() => undefined);
    }
  }
  async function records(account: LocalAccount): Promise<string> {
    const directories = await inspectRuntimeDirectories(layout, account.uid, acl, new AbortController().signal);
    const execution = await new ExecutionLeaseStore(createExecutionFilesAt(directories.runPolicy)).read('core');
    const history = await createRuntimeStores(directories).lifecycle.read('core');
    const telemetry = createTelemetryFilesAt(directories.runPolicy, directories.logsPolicy);
    const hints = [
      await createCoreProcessFilesAt(directories.runPolicy).read('core'),
      await telemetry.status.read('core'),
      await telemetry.events.read('core'),
    ];
    if (
      execution.state !== 'FREE' ||
      execution.revision !== 0 ||
      history.history.blocked !== false ||
      history.history.activeAttempt !== null ||
      history.history.exitsMs.length !== 0 ||
      history.history.lastGeneration !== null ||
      hints.some((group) => group.length === 0 || group.some((bytes) => bytes !== null))
    )
      refuse();
    await directories.verify();
    return shaBytes(Buffer.concat([encodeExecution(execution), Buffer.from(history.digest)]));
  }
  async function snapshot(stage: 'PUBLISHED' | 'STARTED', running: boolean): Promise<Snapshot> {
    if (!Object.values(options.pins).every(hex)) refuse();
    const account = await options.account();
    if (!account || account.name !== 'gram-agent' || account.admin !== false || account.groupsComplete !== true)
      refuse();
    const registry = await options.registry();
    if (
      !registry ||
      registry.jobs.core !== (running ? 'present' : 'absent') ||
      registry.overrides.core !== !running ||
      registry.jobs.tunnel !== 'absent' ||
      registry.overrides.tunnel === true
    )
      refuse();
    const ports = await options.ports();
    if (ports.tunnel !== 'free' || (!running && ports.core !== 'free')) refuse();
    const live = {} as Record<PublishKind, Buffer | null>;
    const staged = {} as Record<PublishKind, Buffer | null>;
    for (const kind of kinds) {
      live[kind] = await storage.readLive(kind);
      staged[kind] = await storage.publish.readStaged(kind);
    }
    if (
      live.configuration === null ||
      live.manifest === null ||
      live.journal === null ||
      live.core === null ||
      live.tunnel !== null ||
      staged.tunnel !== null ||
      ['configuration', 'manifest', 'core'].some((kind) => staged[kind as PublishKind] !== null)
    )
      refuse();
    const config = parseConfig(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(live.configuration)));
    if (
      config.tunnel.enabled ||
      config.releaseDigest !== options.pins.releaseDigest ||
      !live.configuration.equals(canonicalConfigBytes(config))
    )
      refuse();
    const core = expectedPlistBytes(config, 'core');
    if (core === null || !live.core.equals(core)) refuse();
    const manifest = buildManifest({
      runtime: { name: 'gram-agent', uid: account.uid, gid: account.gid },
      configBytes: live.configuration,
      releaseId: config.releaseId,
      releaseDigest: config.releaseDigest,
      corePlist: core,
      tunnelPlist: null,
    });
    if (!live.manifest.equals(manifest.bytes) || manifest.sha !== options.pins.manifestDigest) refuse();
    const expected = buildIntermediateJournal(stage, {
      previousDigest: null,
      nextDigest: manifest.sha,
      inventory: Object.values(FIXED_FILES),
    });
    if (
      !live.journal.equals(expected) ||
      (stage === 'PUBLISHED' && shaBytes(live.journal) !== options.pins.journalDigest) ||
      staged.journal === null ||
      !staged.journal.equals(buildCommittedJournal(manifest.bytes))
    )
      refuse();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RELEASE_REVIEW_TIMEOUT_MS);
    try {
      await inspectRelease(
        config,
        config.releaseDigest,
        createTrustedFiles(layout.anchor, layout.ownerUid, acl, `${layout.relative}/releases/${config.releaseId}`),
        controller.signal,
      );
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    const key = await keyMetadata(account);
    if (JSON.stringify(await options.registry()) !== JSON.stringify(registry)) refuse();
    for (const kind of kinds) {
      const now = await storage.readLive(kind);
      const pending = await storage.publish.readStaged(kind);
      if (
        (now === null ? live[kind] !== null : live[kind] === null || !now.equals(live[kind])) ||
        (pending === null ? staged[kind] !== null : staged[kind] === null || !pending.equals(staged[kind]))
      )
        refuse();
    }
    return { live, staged, key, registry, account };
  }
  async function unchanged(stage: 'PUBLISHED' | 'STARTED', running: boolean): Promise<boolean> {
    if (!approved) return false;
    const current = await snapshot(stage, running);
    const previous = approved.snapshot;
    if (
      current.key !== previous.key ||
      JSON.stringify(current.account) !== JSON.stringify(previous.account) ||
      current.registry.overrides.tunnel !== previous.registry.overrides.tunnel
    )
      return false;
    return kinds
      .filter((kind) => kind !== 'journal')
      .every((kind) => {
        const a = current.live[kind];
        const b = previous.live[kind];
        return a === null ? b === null : b !== null && a.equals(b);
      });
  }
  return Object.freeze<FreshPublishedResumePorts>({
    authorizeLocalAdmin: () => options.authorizeLocalAdmin(),
    lock: () => storage.lock(),
    async review() {
      try {
        approved = null;
        const view = await snapshot('PUBLISHED', false);
        const state = await records(view.account);
        // Initial private state and key are pinned again before returning a token.
        if ((await records(view.account)) !== state || (await keyMetadata(view.account)) !== view.key) return null;
        const token = shaBytes(
          Buffer.from(
            JSON.stringify({
              live: kinds.map((kind) => [kind, view.live[kind] === null ? null : shaBytes(view.live[kind])]),
              staged: kinds.map((kind) => [kind, view.staged[kind] === null ? null : shaBytes(view.staged[kind])]),
              key: view.key,
              registry: view.registry,
              account: view.account,
              records: state,
            }),
          ),
        );
        const manifest = view.live.manifest;
        if (!manifest) return null;
        approved = {
          snapshot: view,
          token,
          records: state,
          started: buildIntermediateJournal('STARTED', {
            previousDigest: null,
            nextDigest: shaBytes(manifest),
            inventory: Object.values(FIXED_FILES),
          }),
          committed: buildCommittedJournal(manifest),
        };
        return { transactionDigest: token };
      } catch {
        approved = null;
        return null;
      }
    },
    async startCore() {
      if (
        !approved ||
        !(await unchanged('PUBLISHED', false)) ||
        (await records(approved.snapshot.account)) !== approved.records
      )
        return { ok: false, code: 'PARTIAL_INSTALL' };
      requested = true;
      const result = await options.services.start('core');
      attemptPin = await options.startAttempt.capture();
      return result;
    },
    async ownedCore() {
      if (!requested || !approved || (await options.services.ownedHealthy('core')) !== true) return null;
      const pin = await options.proof.capture();
      if (!hex(pin) || !(await options.proof.current(pin, 'OWNED'))) return null;
      ownedPin = pin;
      return pin;
    },
    async markStarted(token) {
      if (
        !approved ||
        token !== approved.token ||
        !ownedPin ||
        !(await unchanged('PUBLISHED', true)) ||
        (await options.services.ownedHealthy('core')) !== true ||
        !(await options.proof.current(ownedPin, 'OWNED'))
      )
        return 'refused';
      const expected = approved.snapshot.live.journal;
      if (!expected || !(await storage.journal.read())?.equals(expected)) return 'refused';
      try {
        // Cooperative conditional transition, never an unconditional promotion.
        await storage.journal.writeStage('STARTED', approved.started);
        return (await storage.journal.read())?.equals(approved.started) === true ? 'confirmed' : 'uncertain';
      } catch {
        return 'uncertain';
      }
    },
    async parkCore(pin) {
      if (
        !requested ||
        pin !== ownedPin ||
        !approved ||
        !(await unchanged('STARTED', true)) ||
        !(await options.proof.current(pin, 'OWNED'))
      )
        return false;
      stopAttempted = true;
      if ((await options.services.stop('core')).ok !== true || !(await options.proof.current(pin, 'FOREIGN')))
        return false;
      return (
        (await waitForResumeIdle(options.ports)) &&
        (await options.proof.current(pin, 'FOREIGN')) &&
        (await unchanged('STARTED', false))
      );
    },
    async commit(token, pin) {
      if (
        !approved ||
        token !== approved.token ||
        pin !== ownedPin ||
        !(await unchanged('STARTED', false)) ||
        !(await options.proof.current(pin, 'FOREIGN')) ||
        !(await storage.journal.read())?.equals(approved.started)
      )
        return 'refused';
      try {
        await storage.publish.publishFile('journal', approved.committed);
        return (await storage.journal.read())?.equals(approved.committed) === true &&
          (await storage.publish.readStaged('journal')) === null
          ? 'confirmed'
          : 'uncertain';
      } catch {
        return 'uncertain';
      }
    },
    async compensateCore() {
      if (!requested) return true;
      if (!approved) return false;
      const approval = approved;
      const absent = async () => {
        const registry = await options.registry();
        return (
          registry !== null &&
          registry.jobs.core === 'absent' &&
          registry.overrides.core === true &&
          registry.jobs.tunnel === 'absent' &&
          registry.overrides.tunnel !== true
        );
      };
      const stoppedProof = async () => {
        if (ownedPin) return options.proof.current(ownedPin, 'FOREIGN');
        return (
          attemptPin !== null &&
          (await options.startAttempt.current(attemptPin, 'FOREIGN')) &&
          (await records(approval.snapshot.account)) === approval.records
        );
      };
      const confirmStopped = async () =>
        (await absent()) &&
        (await stoppedProof()) &&
        (await waitForResumeIdle(options.ports)) &&
        (await absent()) &&
        (await stoppedProof());
      if (stopAttempted || (await absent())) return confirmStopped();
      // A failed health check does not establish Core ownership. Capture a
      // stop-only Core proof if possible, otherwise require the separately
      // pinned supervisor start-attempt and unchanged initial private state.
      if (!ownedPin) {
        const pin = await options.proof.capture();
        if (hex(pin)) ownedPin = pin;
      }
      const journal = await storage.journal.read();
      const phase = journal?.equals(approved.started)
        ? 'STARTED'
        : journal?.equals(approved.snapshot.live.journal ?? Buffer.alloc(0))
          ? 'PUBLISHED'
          : null;
      if (phase === null || !(await unchanged(phase, true))) return false;
      if (ownedPin) {
        if (!(await options.proof.current(ownedPin, 'OWNED'))) return false;
      } else {
        if (
          !attemptPin ||
          (await records(approved.snapshot.account)) !== approved.records ||
          !(await options.startAttempt.current(attemptPin, 'OWNED'))
        )
          return false;
      }
      stopAttempted = true;
      if ((await options.services.stop('core')).ok !== true) return false;
      return confirmStopped();
    },
  });
}
