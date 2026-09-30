# MAC-02 D / issue142 CLI delivery

Status: IMPLEMENTED / INTEGRATION_PENDING. Draft delivery only. No standalone installed CLI, native service wiring or user-device acceptance is claimed.

## References and isolation

- Task7: https://github.com/jskjw157/gram-coding-agent/blob/31e66aa21b705b1793f11122c1b12d5ebf41715c/docs/superpowers/plans/2026-09-20-macos-service-lifecycle.md#L562-L621
- Spec: https://github.com/jskjw157/gram-coding-agent/blob/3b66075d9ef4cf2d7e87416547ea807b43ec856e/docs/superpowers/specs/2026-09-20-macos-lifecycle-design.md#L101-L153
- Ownership: #139 / #142; CLAIM5918162838. Code base3f5a3509055144358324bd1c41b436833097ab9a; PR target feat/macos-service-lifecycle. Consumer contracts/config/preflight/telemetry/health-probe/test/build config are blob-identical at target30421e6.
- Independent bare clone plus linked worktree. No Windows checkout/Git state/process changes, M2 copying, main/#138 direct changes or external lane modifications.

## Implemented contracts and A wiring

- `diagnostic.ts`: `projectStatus(evidence:unknown):LifecycleReport`. Exact role/state/code/generation/release/freshness checks reuse existing telemetry logic. Missing/malformed/future/30000ms-old/wrong-context evidence becomes UNKNOWN with null identity/age. Always LAB_ONLY and businessReadiness UNAVAILABLE.
- `cli.ts`: `runCli(argv:readonly string[],deps:CliDeps):Promise<number>`. Default preview; explicit preview/status require only --json. Mutation grammar is the exact issue142 fixed symbolic reference and lowercase digest flags; rollback additionally requires a target release digest. No generic execution, secret, label/role/port/path/URL options.
- `CliDeps` in `cli-contracts.ts`: optional `preview():Promise<Preview>`, `status():Promise<DiagnosticEvidence>`, `apply(ExpectedInstallRequest):Promise<Result>`, `rollback(RollbackRequest):Promise<Result>`, `control(LocalControlAction,ExpectedInstallRequest):Promise<Result>`; required `output(jsonLine:string):void|Promise<void>`.
- ExpectedInstallRequest is `{config:'service',expectedPreviewDigest:string,expectedInstallDigest:string|null}`. RollbackRequest adds `targetReleaseDigest`. `none` maps to null. Preview composite token is retained, not replaced by config/manifest/release SHA.
- DiagnosticEvidence is `{nowMs:number,core:RoleObservation,tunnel:RoleObservation}`; RoleObservation is `{status:unknown,currentIdentity:StatusIdentity|null}`. This is INTERNAL port data, not serialized native proof. A must supply an independently verified current local context, invalidate it on reboot/owner replacement and provide authenticated health. A plain stored record or caller-owned object must never be that source. No new persisted boot/schema fields.
- Public status/preview use issue142 envelopes. Mutation/error output is closed `{schemaVersion:1,mode:'LAB_ONLY',action,businessReadiness:'UNAVAILABLE',result:{ok,code}}`. Invalid grammar has action=null. CLI-only errors INVALID_USAGE/CAPABILITY_UNAVAILABLE do not extend shared SafeCode. All provider objects are strictly validated and copied; no raw spread/errors/paths/credentials.
- Exit0 means completed request,2 means refusal/absent capability,64 means invalid grammar,70 means fixed internal/malformed-provider/output failure. An invoked provider returning null/undefined is malformed; it may already have acted. Output completion is awaited and its failure is contained without a second output attempt.
- Imports/construction do not install, launch, connect or acquire credentials. A owns native entry, shared exports/bin/workflows, installer-result mapping and actual authorization/evidence. B engines and C packager are not imported or duplicated.

## Plan review decisions

The existing Task7 is reused, not rewritten. Its sample's runCli import is corrected to cli.js; projectStatus remains diagnostic.js. Current139/142 ownership excludes Task7's packaging/core-probe/shared-export/runbook work from D. Separate local report/port types fill the original plan's missing signatures without changing shared or persisted schemas. Their compatibility must be checked when A wires the ports.

The user explicitly extended automatic code work to Mac. Repeated plan-stage questions were omitted; internal design/plan review, TDD and final independent review were retained. Deployment, real accounts/credentials/security settings/services were not authorized or performed.

## Observed verification

Local native arm64 tools: official Node24.20.0 (SHA256 checked), pnpm10.34.5 in this task folder; frozen existing dependency installation. No global tool changes. pnpm added an empty importer during install; that generated tracked change was removed and lockfile bytes match the baseline.

- Task1 explicit NOT_IMPLEMENTED behavior RED38/38; GREEN38/38. Missing-import scaffolding evidence is not counted as behavior RED.
- Task2 explicit NOT_IMPLEMENTED behavior RED63/63; fixed internal-error exit behavior RED2/2. Initial table nesting was corrected so actual argv arrays, not individual string cells, are tested.
- Independent whole-diff reviewer found two Important issues: output completion/rejection not awaited; invoked null/undefined result mislabeled as absent capability. Both were reproduced in a five-failure RED run, then fixed in one pass. Final targeted **106/106 pass** (38 diagnostic +68 CLI); no deferred minor findings.
- Fresh root lint/typecheck/build and git diff --check passed.
- Compiled-module smoke passed: import has no added active native resources; preview/status, exits0/2/64/70, async output rejection and retained temporary-file bytes. CLI test/test-support artifacts are excluded from lifecycle dist.
- **Local full regression remains red in one unchanged native test**: `macos-service-probes.native.test.ts` / `observes a real fixed-port fixture without connecting to it`, initial inspectMacPorts().core=unknown. Before changes:693 root passed/1failed. After final fixes/build:847 root passed/1failed; lifecycle before final review:748passed/1failed. Root post-build counts include existing packages' compiled test collection, so these are observed invocations, not distinct added tests.
- A sandboxed initial scaffold command accidentally collected the broader suite and had loopback listen EPERM failures; it is not feature RED or native acceptance. Correct full checks ran with test permissions and reproduced only the unchanged port-observation failure. No test expectations/skips/native adapter were weakened or changed.

Commands: `pnpm --filter @gram/macos-lifecycle test`; `pnpm exec vitest run --project macos-lifecycle`; `pnpm lint`; `pnpm typecheck`; `pnpm test`; `pnpm build`; `git diff --check`. Targeted: `pnpm --filter @gram/macos-lifecycle exec vitest run src/cli.test.ts src/diagnostic.test.ts`.

Hosted CI exact heads and PR integration checks must be read back separately; local results are not a claim of hosted CI success. Installed native entry, real authorization/credential/provider, service start/install, logout/reboot and business acceptance remain NOT_RUN.

## Integration gates and follow-up

Keep Draft until required CI, known native observation concern, A evidence/installer port mapping and combined regression gates have evidence. #139 assigns final integration to A; do not directly merge this delivery into main or bypass pending integration by changing shared files. A/C/B lanes remain separately owned. A context-to-report wiring and C packager consumer checks are related follow-ups for the coordinator; this worker has not claimed them.
