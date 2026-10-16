import { constants, writeSync } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const started = performance.now();
const controller = new AbortController();
let reviewReported = false;
let reviewElapsedMs = -1;
let diagnosticsStarted = -1;
let diagnosticsComplete = false;
const timer = setTimeout(() => {
  controller.abort();
  finish('TIMEOUT', false);
}, 60_000);

function emit(label, fields) {
  writeSync(1, `${label} ${JSON.stringify(fields)}\n`);
}

function reportReview(result, reviewOk) {
  reviewElapsedMs = Math.round(performance.now() - started);
  reviewReported = true;
  emit('NATIVE_REVIEW_DIAG', {
    result, review_ok: reviewOk, elapsed_ms: reviewElapsedMs,
    uid: process.getuid(), gid: process.getgid(), aborted: controller.signal.aborted,
  });
}

function finish(result, reviewOk) {
  clearTimeout(timer);
  try {
    if (!reviewReported) reportReview(result, reviewOk);
    else if (diagnosticsStarted >= 0) emit('NATIVE_REVIEW_DETAIL_DONE', {
      diagnostics_complete: diagnosticsComplete,
      review_elapsed_ms: reviewElapsedMs,
      diag_elapsed_ms: Math.round(performance.now() - diagnosticsStarted),
      aborted: controller.signal.aborted,
    });
  } finally {
    process.exit(0);
  }
}

async function diagnose(source, acl) {
  const fixedRoot = '/Library/Application Support/HAAR/GramAgent';
  // Fixed numeric IDs only: 0-7 are the config chain and its two files;
  // 8-10 extend the shared root chain to the independent bootstrap helper.
  const paths = ['/', '/Library', '/Library/Application Support',
    '/Library/Application Support/HAAR', fixedRoot, `${fixedRoot}/config`,
    `${fixedRoot}/config/service.json`, `${fixedRoot}/config/installation.json`,
    `${fixedRoot}/bootstrap`, `${fixedRoot}/bootstrap/bin`, `${fixedRoot}/bootstrap/bin/file-acl`];
  const isLeaf = id => id === 6 || id === 7 || id === 10;
  const same = (a, b) => ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs']
    .every(key => a[key] === b[key]);

  async function inspectPath(id, probeAcl) {
    const row = { id, stat_ok: false, type: 0, uid: -1, gid: -1, mode: -1, nlink: -1,
      open_ok: false, identity_ok: false, acl_checked: false, acl_ok: false };
    let file;
    try {
      const before = await lstat(paths[id], { bigint: true });
      Object.assign(row, { stat_ok: true, type: before.isDirectory() ? 1 : before.isFile() ? 2 : 0,
        uid: Number(before.uid), gid: Number(before.gid), mode: Number(before.mode & 0o7777n),
        nlink: Number(before.nlink) });
      if (row.type !== (isLeaf(id) ? 2 : 1)) return row;
      file = await open(paths[id], constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        | (isLeaf(id) ? 0 : constants.O_DIRECTORY));
      row.open_ok = true;
      row.identity_ok = same(before, await file.stat({ bigint: true }))
        && same(before, await lstat(paths[id], { bigint: true }));
      if (probeAcl && row.identity_ok) {
        row.acl_checked = true;
        row.acl_ok = await acl(file) === true;
      }
      row.identity_ok = row.identity_ok && same(before, await file.stat({ bigint: true }))
        && same(before, await lstat(paths[id], { bigint: true }));
    } catch {
      // The individual false fields are the evidence; never emit error text.
      row.identity_ok = false;
    } finally {
      if (file) await file.close().catch(() => undefined);
    }
    return row;
  }

  let helperFailId = -1;
  for (const id of [1, 2, 3, 4, 8, 9, 10]) {
    const row = await inspectPath(id, false);
    const safe = row.stat_ok && row.open_ok && row.identity_ok && row.uid === 0
      && (row.mode & 0o022) === 0 && row.type === (id === 10 ? 2 : 1)
      && (id !== 10 || row.nlink === 1 && (row.mode & 0o111) !== 0);
    if (!safe && helperFailId === -1) helperFailId = id;
    if (id >= 8) emit('NATIVE_REVIEW_PATH_DIAG', row);
  }
  emit('NATIVE_REVIEW_HELPER_DIAG', {
    helper_chain_checked: true, helper_chain_ok: helperFailId === -1, helper_fail_id: helperFailId,
  });
  for (let id = 0; id <= 7; id++) emit('NATIVE_REVIEW_PATH_DIAG', await inspectPath(id, true));

  const [{ createTrustedFiles }, { parseConfig }, { validateManifestBytes, shaBytes }] = await Promise.all([
    import(new URL('adapters/trusted-files.js', source).href),
    import(new URL('config.js', source).href),
    import(new URL('adapters/install-files.js', source).href),
  ]);
  const files = createTrustedFiles('/', 0, acl, `${fixedRoot.slice(1)}/config`);
  let configBytes = null;
  let manifestBytes = null;
  try { configBytes = await files.read('service.json', 262144); } catch { /* observed below */ }
  try { manifestBytes = await files.read('installation.json', 262144); } catch { /* observed below */ }
  const binding = { config_read_ok: configBytes !== null, manifest_read_ok: manifestBytes !== null,
    config_parse_ok: false, manifest_schema_ok: false, binding_checked: false,
    runtime_name_match: false, runtime_uid_match: false, runtime_gid_match: false,
    config_sha_match: false, release_id_match: false, release_digest_match: false, pre_release_ok: false };
  let config = null;
  if (configBytes !== null) {
    try {
      config = parseConfig(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(configBytes)));
      binding.config_parse_ok = true;
    } catch { /* observed below */ }
  }
  // The production validator checks exact top-level/nested keys, schema 1,
  // COMMITTED state, runtime identity shape and disabled desired state.
  binding.manifest_schema_ok = manifestBytes !== null && validateManifestBytes(manifestBytes);
  if (config !== null && binding.manifest_schema_ok) {
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
    binding.binding_checked = true;
    binding.runtime_name_match = manifest.runtime.name === 'gram-agent';
    binding.runtime_uid_match = manifest.runtime.uid === process.getuid();
    binding.runtime_gid_match = manifest.runtime.gid === process.getgid();
    binding.config_sha_match = manifest.configSha256 === shaBytes(configBytes);
    binding.release_id_match = manifest.releaseId === config.releaseId;
    binding.release_digest_match = manifest.releaseDigest === config.releaseDigest;
    binding.pre_release_ok = manifest.schemaVersion === 1 && manifest.state === 'COMMITTED'
      && binding.runtime_name_match && binding.runtime_uid_match && binding.runtime_gid_match
      && binding.config_sha_match && binding.release_id_match && binding.release_digest_match;
  }
  emit('NATIVE_REVIEW_BINDING_DIAG', binding);
}

async function diagnoseRuntime(source, acl, review) {
  const [{ inspectRuntimeDirectories }, { createPrivateRecordFiles },
    { decodeExecution }, { decodeHistory },
    { decodeCoreRegistration, matchesCoreExecution, coreStartIdentity },
    { decodeStatus, parseEvent }, { createTrustedFiles }, { createNativePeerProof }] = await Promise.all([
    import(new URL('adapters/runtime-directories.js', source).href),
    import(new URL('adapters/private-record-files.js', source).href),
    import(new URL('execution-lease.js', source).href),
    import(new URL('lifecycle-store.js', source).href),
    import(new URL('core-registration.js', source).href),
    import(new URL('telemetry.js', source).href),
    import(new URL('adapters/trusted-files.js', source).href),
    import(new URL('adapters/owned-process.js', source).href),
  ]);
  const fixedRoot = '/Library/Application Support/HAAR/GramAgent';
  const directories = await inspectRuntimeDirectories(
    { anchor: '/', relative: fixedRoot.slice(1), ownerUid: 0 },
    process.getuid(), acl, controller.signal,
  );
  emit('NATIVE_RUNTIME_DIR_DIAG', { directories_ok: true });
  const snapshots = new Map();
  for (const kind of ['execution', 'circuit', 'process', 'status', 'events']) {
    if (controller.signal.aborted) return;
    const readStarted = Date.now();
    try {
      await directories.verify();
      const policy = kind === 'events' ? directories.logsPolicy : directories.runPolicy;
      // Only the existing fixed-family read API is used. No CAS, initialization,
      // recovery, session, credential or HTTP operation is performed.
      const bytes = await createPrivateRecordFiles(kind, policy).read('core');
      await directories.verify();
      const readFinished = Date.now();
      snapshots.set(kind, { bytes, readStarted, readFinished });
      emit('NATIVE_RUNTIME_READ_DIAG', {
        kind, read_ok: true, present: bytes.some(value => value !== null),
        elapsed_ms: Math.max(0, readFinished - readStarted),
      });
    } catch {
      emit('NATIVE_RUNTIME_READ_DIAG', {
        kind, read_ok: false, present: false, elapsed_ms: Math.max(0, Date.now() - readStarted),
      });
    }
  }
  const first = kind => snapshots.get(kind)?.bytes[0] ?? null;
  const held = first('execution') === null ? null : decodeExecution(first('execution'));
  const history = first('circuit') === null ? null : decodeHistory(first('circuit'));
  const registration = first('process') === null ? null : decodeCoreRegistration(first('process'));
  const status = first('status') === null ? null : decodeStatus(first('status'));
  const statusRead = snapshots.get('status');
  const sameReview = value => value !== null && value.releaseDigest === review.config.releaseDigest;
  const matched = held !== null && registration !== null && matchesCoreExecution(registration, held);
  emit('NATIVE_RUNTIME_RECORD_DIAG', {
    execution_state: held?.state ?? 'UNAVAILABLE', execution_revision: held?.revision ?? -1,
    execution_config_match: held?.configDigest === review.configDigest,
    execution_release_match: sameReview(held),
    circuit_blocked: history?.blocked ?? null, circuit_active: history?.activeAttempt !== null && history !== null,
    circuit_exit_count: history?.exitsMs.length ?? -1,
    registration_present: registration !== null, registration_execution_match: matched,
    registration_config_match: registration?.configDigest === review.configDigest,
    registration_release_match: sameReview(registration?.child ?? null),
    status_state: status?.state ?? 'UNAVAILABLE', status_code: status?.code ?? 'UNAVAILABLE',
    status_attempt: status?.attemptCount ?? -1,
    status_age_ms: status === null ? -1 : statusRead.readFinished - status.observedAtMs,
    status_after_read_start: status !== null && status.observedAtMs > statusRead.readStarted,
    status_after_read_end: status !== null && status.observedAtMs > statusRead.readFinished,
    status_execution_generation_match: status !== null && status.generation === held?.generation,
    status_registration_generation_match: status !== null && status.generation === registration?.child.generation,
    status_release_match: sameReview(status),
  });
  const generation = registration?.child.generation ?? held?.generation ?? history?.lastGeneration;
  const events = [];
  for (const bytes of snapshots.get('events')?.bytes ?? []) {
    if (bytes === null) continue;
    // The fixed record adapter already validated every canonical segment line.
    for (const line of bytes.toString('utf8').split('\n').slice(1, -1)) {
      const event = parseEvent(JSON.parse(line));
      if (event.generation === generation && sameReview(event)) events.push(event);
    }
  }
  events.sort((a, b) => a.observedAtMs - b.observedAtMs);
  emit('NATIVE_RUNTIME_EVENT_DIAG', {
    matching_event_count: events.length,
    recent: events.slice(-16).map(event => ({
      code: event.code, attempt: event.attemptCount, age_ms: Date.now() - event.observedAtMs,
    })),
  });
  if (registration === null || controller.signal.aborted) return held;
  const releasePrefix = `${fixedRoot.slice(1)}/releases/${review.config.releaseId}`;
  const releaseFiles = createTrustedFiles('/', 0, acl, releasePrefix);
  const nodePath = `${fixedRoot}/releases/${review.config.releaseId}/bin/node`;
  const helperPath = `${fixedRoot}/releases/${review.config.releaseId}/bin/peer-owner`;
  const node = await lstat(nodePath, { bigint: true });
  const observerNode = await lstat(nodePath);
  const pinsOk = node.isFile() && node.uid === 0n && node.nlink === 1n
    && (node.mode & 0o6022n) === 0n && (node.mode & 0o111n) !== 0n
    && await releaseFiles.hash('bin/node', 256 * 1024 * 1024) === review.nodeDigest
    && await releaseFiles.hash('bin/peer-owner', 256 * 1024 * 1024) === review.peerOwnerDigest;
  let verdict = 'UNAVAILABLE';
  if (pinsOk && !controller.signal.aborted) {
    const start = coreStartIdentity(registration.child.startIdentity);
    verdict = await createNativePeerProof(helperPath).current({
      pid: registration.child.pid, uid: registration.child.uid,
      startSec: start.sec, startUsec: start.usec, executable: { dev: node.dev, ino: node.ino },
    }, controller.signal);
  }
  // This is a post-compensation process observation. It does not recreate the
  // supervisor's protected proof call or establish authenticated Core health.
  emit('NATIVE_RUNTIME_PROCESS_DIAG', {
    pins_ok: pinsOk, verdict, aborted: controller.signal.aborted,
    observer_inode_safe_integer: Number.isSafeInteger(observerNode.ino),
    observer_numeric_identity_exact: BigInt(observerNode.ino) === node.ino && BigInt(observerNode.dev) === node.dev,
  });
  return held;
}

async function diagnoseSelfProof(source, acl, review, initialHeld) {
  // Read-only post-compensation probe of THIS diagnostic process, not the prior
  // Core child. It cannot establish which earlier startup phase failed.
  const emitStage = (stage, event, fields = {}) => emit('NATIVE_SELF_PROOF_DIAG', {
    stage, event, ...fields, aborted: controller.signal.aborted,
  });
  if (initialHeld?.schemaVersion !== 1 || initialHeld.role !== 'core' || initialHeld.state !== 'HELD'
    || initialHeld.configDigest !== review.configDigest
    || initialHeld.releaseDigest !== review.config.releaseDigest || controller.signal.aborted) {
    emitStage('gate', 'SKIPPED', { held_match: false });
    return;
  }
  const [{ bindReviewedCoreRuntime }, { encodeExecution }, { createTrustedFiles },
    { createNativePeerProof }, { coreStartIdentity }] = await Promise.all([
    import(new URL('adapters/runtime-authority.js', source).href),
    import(new URL('execution-lease.js', source).href),
    import(new URL('adapters/trusted-files.js', source).href),
    import(new URL('adapters/owned-process.js', source).href),
    import(new URL('core-registration.js', source).href),
  ]);
  const expectedHeld = encodeExecution(initialHeld);
  async function observe(stage, use) {
    const began = performance.now();
    emitStage(stage, 'START');
    try {
      const value = await use();
      emitStage(stage, 'DONE', { ok: value !== null && value !== false,
        elapsed_ms: Math.round(performance.now() - began) });
      return value;
    } catch {
      emitStage(stage, 'ERROR', { ok: false, elapsed_ms: Math.round(performance.now() - began) });
      return null;
    }
  }
  const runtime = await observe('bind', () => bindReviewedCoreRuntime(review, acl, controller.signal));
  if (!runtime || controller.signal.aborted) return;
  const heldUnchanged = async () => !controller.signal.aborted
    && expectedHeld.equals(encodeExecution(await runtime.execution.read('core')))
    && !controller.signal.aborted;
  if (!await heldUnchanged()) { emitStage('gate', 'SKIPPED', { held_match: false }); return; }
  // This authority method validates and reads an already HELD record. It is
  // NOT ExecutionLeaseStore.acquire and never initializes, acquires or releases
  // a reservation. No session, credential, HTTP or Core launch follows it.
  const grant = await observe('grant', () => runtime.authority.acquire(review.config, controller.signal));
  if (!grant || controller.signal.aborted) return;
  if (!await heldUnchanged()) { emitStage('gate', 'SKIPPED', { held_match: false }); return; }
  const fixedRoot = '/Library/Application Support/HAAR/GramAgent';
  const releasePrefix = fixedRoot.slice(1) + '/releases/' + review.config.releaseId;
  const nodePath = '/' + releasePrefix + '/bin/node';
  const helperPath = '/' + releasePrefix + '/bin/peer-owner';
  const files = createTrustedFiles('/', 0, acl, releasePrefix);
  const same = (a, b) => ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs']
    .every(key => a[key] === b[key]);
  const safeExecutable = value => value.isFile() && value.uid === 0n && value.nlink === 1n
    && (value.mode & 0o6022n) === 0n && (value.mode & 0o111n) !== 0n;
  emitStage('identity', 'START');
  const node = await lstat(nodePath, { bigint: true });
  const self = await lstat(process.execPath, { bigint: true });
  const helper = await lstat(helperPath, { bigint: true });
  const identityOk = process.execPath === nodePath && safeExecutable(node) && safeExecutable(helper)
    && same(node, self) && grant.configDigest === review.configDigest
    && grant.account.name === 'gram-agent' && grant.account.admin === false
    && grant.account.uid === process.getuid() && grant.account.gid === process.getgid()
    && grant.executable.dev === node.dev && grant.executable.ino === node.ino;
  const pinsOk = identityOk
    && await files.hash('bin/node', 256 * 1024 * 1024) === review.nodeDigest
    && await files.hash('bin/peer-owner', 256 * 1024 * 1024) === review.peerOwnerDigest
    && same(node, await lstat(nodePath, { bigint: true }))
    && same(helper, await lstat(helperPath, { bigint: true }));
  emitStage('identity', 'DONE', { identity_ok: identityOk, pins_ok: pinsOk });
  if (!pinsOk || !await heldUnchanged()) { emitStage('capture', 'SKIPPED'); return; }
  const request = Object.freeze({ pid: process.pid, uid: grant.account.uid,
    executable: Object.freeze({ dev: node.dev, ino: node.ino }) });
  const validCapture = value => {
    try {
      if (value === null || typeof value?.sec !== 'string' || typeof value?.usec !== 'string') return false;
      coreStartIdentity(value.sec + '.' + value.usec);
      return true;
    } catch { return false; }
  };
  const wrapped = await observe('wrapped_capture', async () => {
    const value = await grant.proof.capture(request, controller.signal);
    return validCapture(value) ? value : null;
  });
  if (controller.signal.aborted || !await heldUnchanged()) { emitStage('bare_capture', 'SKIPPED'); return; }
  const helperStillPinned = await files.hash('bin/peer-owner', 256 * 1024 * 1024) === review.peerOwnerDigest
    && same(helper, await lstat(helperPath, { bigint: true }));
  if (!helperStillPinned || controller.signal.aborted) { emitStage('bare_capture', 'SKIPPED'); return; }
  const bare = await observe('bare_capture', async () => {
    const value = await createNativePeerProof(helperPath).capture(request, controller.signal);
    return validCapture(value) ? value : null;
  });
  emitStage('comparison', 'DONE', { wrapped_ok: wrapped !== null, bare_ok: bare !== null,
    same_capture: wrapped !== null && bare !== null && wrapped.sec === bare.sec && wrapped.usec === bare.usec,
    held_unchanged: await heldUnchanged(),
    helper_unchanged: await files.hash('bin/peer-owner', 256 * 1024 * 1024) === review.peerOwnerDigest
      && same(helper, await lstat(helperPath, { bigint: true })),
    node_unchanged: same(node, await lstat(nodePath, { bigint: true })) });
}

try {
  const source = new URL('../packages/macos-lifecycle/dist/a-system-sources.js', pathToFileURL(process.execPath));
  const { createSystemBootstrapSources } = await import(source.href);
  const sources = createSystemBootstrapSources();
  const review = await sources.review.read(controller.signal);
  reportReview(review === null ? 'REFUSED' : 'READY', review !== null);
  if (!controller.signal.aborted) {
    diagnosticsStarted = performance.now();
    try {
      if (review === null) await diagnose(source, sources.acl);
      else {
        const held = await diagnoseRuntime(source, sources.acl, review);
        await diagnoseSelfProof(source, sources.acl, review, held);
      }
      diagnosticsComplete = true;
    } catch { /* Preserve the review result; report incomplete diagnostics. */ }
  }
  finish(review === null ? 'REFUSED' : 'READY', review !== null);
} catch {
  finish('ERROR', false);
}
