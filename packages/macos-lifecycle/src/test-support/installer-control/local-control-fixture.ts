import type {
  InstallResult,
  JournalPort,
  PriorInstall,
} from '../../installation-transaction/contracts.js';
import type { LocalControlRestorePort } from '../../installation-transaction/control-contracts.js';
import type { InstallFixture } from '../installer/fixture.js';

/**
 * Installer-control test helpers.
 *
 * Thin monkey-patch wrappers around the read-only `makeInstallFixture`
 * ports (imported, never edited). Each helper patches one narrow seam on
 * `fixture.ports` in place and returns the same fixture for chaining.
 * Production code must compare authorization results with `!== true`;
 * the truthy fake below exists so regression tests can prove that.
 */

/** Counts how often each reset entry was invoked through the patched ports. */
export interface ResetExecutionSpy {
  calls: number;
}

/** Reader for the `ResetExecutionSpy` recorded by the capability helpers. */
export function resetExecutionCalls(spy: ResetExecutionSpy): number {
  return spy.calls;
}

/**
 * Wraps `ports.restore()` to count `resetExecutionRecords()` calls while
 * preserving every other entry (including an already-installed narrow
 * capability). The returned spy reads `0` until the first reset call.
 */
export function withResetExecutionSpy(fixture: InstallFixture): ResetExecutionSpy {
  const spy: ResetExecutionSpy = { calls: 0 };
  const restore = fixture.ports.restore.bind(fixture.ports);
  fixture.ports.restore = (): LocalControlRestorePort => {
    const base: LocalControlRestorePort = restore();
    return {
      ...base,
      resetExecutionRecords: async (): Promise<InstallResult> => {
        spy.calls += 1;
        return base.resetExecutionRecords();
      },
    };
  };
  return spy;
}

/**
 * Installs the narrow `resetStoppedFailure` capability on `ports.restore()`,
 * funnelling into the underlying `resetExecutionRecords()` so the shared spy
 * observes capability use exactly like a direct reset call.
 */
export function withStoppedFailureCapability(fixture: InstallFixture): ResetExecutionSpy {
  const spy: ResetExecutionSpy = { calls: 0 };
  const restore = fixture.ports.restore.bind(fixture.ports);
  fixture.ports.restore = (): LocalControlRestorePort => {
    const base: LocalControlRestorePort = restore();
    const resetExecutionRecords = async (): Promise<InstallResult> => {
      spy.calls += 1;
      return base.resetExecutionRecords();
    };
    return {
      ...base,
      resetExecutionRecords,
      resetStoppedFailure: resetExecutionRecords,
    };
  };
  return spy;
}

/** Strips the narrow `resetStoppedFailure` capability, if one is installed. */
export function withoutStoppedFailureCapability(fixture: InstallFixture): void {
  const restore = fixture.ports.restore.bind(fixture.ports);
  fixture.ports.restore = (): LocalControlRestorePort => {
    const base: LocalControlRestorePort = restore();
    const { resetStoppedFailure: _removed, ...rest } = base;
    void _removed;
    return rest;
  };
}

/** Typed accessor for the restore port carrying the optional narrow capability. */
export function localRestoreOf(fixture: InstallFixture): LocalControlRestorePort {
  return fixture.ports.restore() as LocalControlRestorePort;
}

/**
 * Plants a corrupt live journal: `journal().read()` returns non-JSON garbage
 * bytes, so `validateCommittedJournal` fails and recovery reconciles to
 * `partial`. `writeStage` still delegates (it validates, so it cannot plant
 * corruption itself). `publish().readLive('journal')` is untouched.
 */
export function withCorruptJournal(fixture: InstallFixture): InstallFixture {
  const journal = fixture.ports.journal.bind(fixture.ports);
  const corrupt = Buffer.from('corrupt', 'utf8');
  fixture.ports.journal = (): JournalPort => {
    const base = journal();
    return {
      read: async (): Promise<Buffer | null> => Buffer.from(corrupt),
      writeStage: base.writeStage.bind(base),
    };
  };
  return fixture;
}

/**
 * Plants a mismatched live journal: well-formed committed-journal JSON whose
 * `installationDigest` matches nothing, so the journal parses but fails
 * `validateCommittedJournal` against the live manifest (`partial`, not
 * corrupt). Companion to `withCorruptJournal`, which returns unparseable bytes.
 */
export function withMismatchedJournal(fixture: InstallFixture): InstallFixture {
  const journal = fixture.ports.journal.bind(fixture.ports);
  const mismatched = Buffer.from(
    JSON.stringify({ schemaVersion: 1, stage: 'COMMITTED', installationDigest: '0'.repeat(64) }),
    'utf8',
  );
  fixture.ports.journal = (): JournalPort => {
    const base = journal();
    return {
      read: async (): Promise<Buffer | null> => Buffer.from(mismatched),
      writeStage: base.writeStage.bind(base),
    };
  };
  return fixture;
}

/**
 * Plants a malformed live config: `readPrior()` returns the real prior with
 * `config` replaced by unparseable bytes, so config parsing fails downstream.
 */
export function withMalformedConfig(fixture: InstallFixture): InstallFixture {
  const readPrior = fixture.ports.readPrior.bind(fixture.ports);
  const malformed = Buffer.from('{bad json', 'utf8');
  fixture.ports.readPrior = async (): Promise<PriorInstall> => {
    const prior = await readPrior();
    return { ...prior, config: Buffer.from(malformed) };
  };
  return fixture;
}

/**
 * Strict-boolean fake: authorizes with a truthy non-`true` value. Production
 * code must treat this as denial (`!== true`); the `as unknown as` cast lives
 * here in test-support only, never in production code.
 */
export function withTruthyAuthorize(fixture: InstallFixture): InstallFixture {
  fixture.ports.authorizeLocalAdmin = async (): Promise<boolean> =>
    'yes' as unknown as boolean;
  return fixture;
}

/** Live reader for the fixture's service mutation log (`stop:<role>`, ...). */
export function serviceMutationsOf(fixture: InstallFixture): string[] {
  return fixture.serviceMutations;
}
