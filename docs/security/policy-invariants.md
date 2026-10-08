# Gram Coding Agent security invariant register

> **PREPARATORY DRAFT — NOT M5 ACCEPTANCE.**
> Related work: [#114](https://github.com/jskjw157/gram-coding-agent/issues/114)
> and [#115](https://github.com/jskjw157/gram-coding-agent/issues/115).
> Prerequisite [#112](https://github.com/jskjw157/gram-coding-agent/issues/112)
> remains OPEN. No rule is certified for production by this document; M5 and
> its issues remain unaccepted. Merge requires the user's approval.

## 1. Baseline, identifiers and verification semantics

**Audited M2 SHA:** `d886ce3b98520e4c594e8da73b14e0bed7dbac3e`.
**Review date:** 2026-10-08, Asia/Seoul.
**Branch:** `docs/m5-threat-model-prep`.
**Draft PR base:** `feat/m2-vertical-slice`.
Read the companion [threat model](threat-model.md) for actors, trust assumptions,
current production exposure, issue snapshot and residual risks.

Requirements come from [AGENTS.md](../../AGENTS.md),
the [architecture](../superpowers/specs/2026-09-15-gram-coding-agent-design.md),
the [M5 plan](../superpowers/plans/2026-09-15-m5-hardening-production-readiness.md)
and the [three M2 supplemental specifications](../superpowers/specs/).
Related issue numbers below identify requirement/evidence ownership; except for
the explicitly dated issue snapshot in the threat model, they are not statements
that an issue is complete.

SEC IDs identify requirements, not implementation rule names or passing tests.
Existing examples retain their intended meanings:
`SEC-MCP-001` loopback; `SEC-TUN-001` no runtime admin key;
`SEC-POL-001` protected history; `SEC-WIN-001` raw Windows approval;
`SEC-WIN-002` constrained typed Windows tools; `SEC-SEC-001` no generic secret
read; `SEC-LOCK-001` lock-free PR/CI. Do not reuse an ID for a different rule.
Existing `POL-*` classifier IDs are a separate namespace.

### Evidence used in this draft

- **E-SOURCE:** fixed-commit source/configuration and existing test definitions
  inspected. Every “Actual source” path below exists at the baseline.
- **E-CI:** GitHub reports historical PR
  [CI run 37552771185](https://github.com/jskjw157/gram-coding-agent/actions/runs/37552771185)
  associated with this M2 head as completed/success. This is not a fresh run in
  this task, a guarantee that every named file was collected, or a live WSL test.
- **E-DOC:** document ID/link/path/scope checks and independent source review of
  this draft. They validate documentation, not production behavior.
- **NOT RUN:** no fresh product/security test execution, real target
  Windows/WSL/tunnel acceptance, effective credential-scope check, crash or
  backup/restore experiment in this documentation task.

Implementation statuses below are scoped: **IMPLEMENTED** means an identified
code layer implements the stated narrow control; **PARTIAL/GAP** means the full
rule exceeds that layer; **CONFIG ONLY** means effective deployment is unverified;
**PLANNED** means the relevant production control is absent. “Tests present”
never means “executed here”. None of these labels is a blanket SEC PASS.

[vitest.config.mts](../../vitest.config.mts) selects package/application projects,
not `tests/ops`; [package.json](../../package.json) does not yet define
`test:security` or `test:concurrency`. In addition,
`tests/ops/systemd-contract.test.ts` expects the literal line fragment
`After=gram-coding-agent.service`, while the baseline tunnel unit contains
`After=network-online.target gram-coding-agent.service`.
That assertion appears inconsistent by inspection; no execution/fix is claimed.
Do not infer an ops-contract PASS from the historical root CI result.

## 2. Rule index

| Rule ID | Required property | Current implementation scope |
| --- | --- | --- |
| [SEC-MCP-001](#sec-mcp-001) | Loopback-only MCP listener | Implemented listener check |
| [SEC-MCP-002](#sec-mcp-002) | Internal authentication before MCP dispatch | Implemented shared-controller gate |
| [SEC-TUN-001](#sec-tun-001) | No runtime administrator credential | Configuration contract; runtime scope unverified |
| [SEC-TUN-002](#sec-tun-002) | Official OpenAI tunnel-client only | Configuration contract |
| [SEC-POL-001](#sec-pol-001) | No protected force push/deletion | Partial command/protected-list coverage |
| [SEC-POL-002](#sec-pol-002) | Shell semantics cannot hide risk | Parser regressions implemented; wrapper coverage partial |
| [SEC-POL-003](#sec-pol-003) | Approval binds the effective operation | Partial hash binding; durable single use implemented |
| [SEC-POL-004](#sec-pol-004) | Task/repository code cannot bypass policy | Direct-spawn gate only; process boundary gap |
| [SEC-TASK-001](#sec-task-001) | Correct active task/lease/step authority | Implemented coding/review application binding |
| [SEC-FS-001](#sec-fs-001) | No ordinary task mutation outside worktree | API controls; process/race coverage partial |
| [SEC-WIN-001](#sec-win-001) | Raw Windows execution requires approval | Direct requests covered; descendant gap |
| [SEC-WIN-002](#sec-win-002) | Typed Windows tools cannot execute arbitrary input | Planned |
| [SEC-WIN-003](#sec-win-003) | Safe dynamic path conversion | Existing one-way adapter; M4 service planned |
| [SEC-LOCK-001](#sec-lock-001) | PR/CI observer owns no mutation lease | Implemented normal orchestration |
| [SEC-LOCK-002](#sec-lock-002) | Exact persisted remote confirmation before release | Implemented normal publishing order |
| [SEC-LOCK-003](#sec-lock-003) | Exclusive mutation ownership and fencing | Basic lease implemented; child/crash fencing partial |
| [SEC-LOCK-004](#sec-lock-004) | Ambiguous state retained for recovery | Graceful retention; recovery/janitor planned |
| [SEC-GIT-001](#sec-git-001) | Scoped credentials and intended repository | HTTP controls; remote/helper identity partial |
| [SEC-GIT-002](#sec-git-002) | Publish only exact verified content | Implemented normal production publication |
| [SEC-GIT-003](#sec-git-003) | CI evidence belongs to exact task/SHA/checks | Ingestion matching implemented; durable association partial |
| [SEC-SEC-001](#sec-sec-001) | No generic secret-read capability | Absent tool; internal leases implemented |
| [SEC-SEC-002](#sec-sec-002) | No secrets in Git/logs/SQLite/MCP | Partial redaction; identified uncovered flows |
| [SEC-SEC-003](#sec-sec-003) | Ordinary task children cannot obtain credentials | Environment filtering; ambient-access gap |
| [SEC-DB-001](#sec-db-001) | Integrity-gated state and consistent restore | WAL/migrations implemented; integrity/backup planned |
| [SEC-OPS-001](#sec-ops-001) | Bounded output, storage and process lifetime | Dedicated review reads bounded; generic runner gap |

## 3. Transport and authentication

### SEC-MCP-001

**Loopback-only MCP listener.**

- **Rule:** Allow the MCP listener only on literal `127.0.0.1` or `::1`.
  Reject wildcard, LAN, unspecified and other host values before listening.
- **Actual source:** `packages/mcp/src/server.ts` — `createMcpHttpServer`;
  `apps/agent/src/main.ts` — `startAgent`.
- **Related issues:** [#114](https://github.com/jskjw157/gram-coding-agent/issues/114),
  [#115](https://github.com/jskjw157/gram-coding-agent/issues/115),
  [#121](https://github.com/jskjw157/gram-coding-agent/issues/121).
- **Verification method:** Start the real server with each host candidate in a
  disposable process; rejected hosts must create no socket. For allowed hosts,
  inspect the bound address and verify a LAN connection cannot reach it.
- **Current implementation:** IMPLEMENTED in server construction. Both literal
  IPv4/IPv6 addresses are accepted; hostname resolution is not used as an
  alternative way to approve a bind.
- **Current verification:** E-SOURCE; tests present in
  `packages/mcp/src/server.test.ts` and `apps/agent/src/main.test.ts`.
  Existing IPv4/reject-wildcard tests do not establish the complete IPv6/host
  table or target-machine socket exposure. Fresh/live execution NOT RUN.
- **Future automation:** AT-01: host table including empty host, `0.0.0.0`,
  `::`, LAN IPv4/IPv6 and `localhost`; actual IPv4/IPv6 socket assertions.

### SEC-MCP-002

**Authenticate before dispatch, without disclosing credentials.**

- **Rule:** Every `/mcp` request must pass the configured internal-secret gate
  before a tool is dispatched. Missing/wrong credentials must not grant access
  or appear in errors. The secret must be nonempty.
- **Actual source:** `packages/mcp/src/auth.ts` — `verifyInternalSecret`;
  `packages/mcp/src/server.ts` — HTTP request handler and tool registration.
- **Related issues:** [#114](https://github.com/jskjw157/gram-coding-agent/issues/114),
  [#121](https://github.com/jskjw157/gram-coding-agent/issues/121).
- **Verification method:** Use an authenticated loopback fixture with a dispatch
  spy; missing, wrong-length, same-length wrong and malformed headers must cause
  zero dispatch and credential-free failures. Verify Host rejection separately.
- **Current implementation:** IMPLEMENTED shared-secret gate and equal-length
  timing-safe comparison. `/healthz` is deliberately outside this gate after
  Host validation and must remain minimal metadata. The same authenticated
  controller domain can use approval tools; independent human identity is not
  enforced locally.
- **Current verification:** E-SOURCE; `packages/mcp/src/auth.test.ts`,
  `packages/mcp/src/server.test.ts`, and
  `packages/mcp/src/coding-capability-server.test.ts` exist. This is neither
  full endpoint redaction proof nor a constant-duration failure claim.
- **Future automation:** AT-01: auth/Host/duplicate-header matrix, dispatch
  ordering, safe health payload, tool-error and transport-error canaries.

### SEC-TUN-001

**No administrator API key in the long-running runtime.**

- **Rule:** The agent/tunnel runtime must never carry an OpenAI tunnel
  administration credential. The tunnel worker may use only the restricted
  credential needed to read/use the intended tunnel; generic task processes
  receive neither that credential nor the MCP secret.
- **Actual source:** `config/tunnel-client.example.yaml`;
  `systemd/openai-mcp-tunnel.service`;
  `systemd/gram-coding-agent.service`; `scripts/bootstrap-wsl.sh`;
  `apps/agent/src/main.ts`; `packages/shell/src/command-runner.ts`.
- **Related issues:** [#115](https://github.com/jskjw157/gram-coding-agent/issues/115),
  [#119](https://github.com/jskjw157/gram-coding-agent/issues/119),
  [#121](https://github.com/jskjw157/gram-coding-agent/issues/121).
- **Verification method:** Inspect rendered units and credential provenance;
  verify effective privileges using secret-free account/scope evidence. Seed a
  fake admin credential in startup fixtures and require startup rejection or
  demonstrable exclusion from all long-lived runtime processes.
- **Current implementation:** CONFIG ONLY/PARTIAL. Templates document restricted
  Tunnels Read + Use and isolate the tunnel environment file from the agent unit.
  Main has no fail-fast check for inherited admin credentials or effective key
  privileges. Excluding a variable from children does not remove it from a parent.
- **Current verification:** E-SOURCE; static definitions in
  `tests/ops/systemd-contract.test.ts` exist with the collection/assertion
  caveats above. No real runtime environment or credential scope was inspected.
- **Future automation:** AT-02 and AT-11: startup/service environment canaries,
  parent/child separation and scope evidence. A search for `OPENAI_ADMIN_KEY`
  alone cannot establish that a differently named credential is non-admin.

### SEC-TUN-002

**Official OpenAI tunnel-client is the only MCP tunnel.**

- **Rule:** The ChatGPT-to-Gram MCP transport must use official OpenAI
  `tunnel-client`, target loopback `/mcp`, and supply the internal header through
  protected configuration. Do not substitute another tunnel. Tailscale remains
  an administration network.
- **Actual source:** `systemd/openai-mcp-tunnel.service`;
  `config/tunnel-client.example.yaml`; `scripts/bootstrap-wsl.sh`;
  `docs/operations/tunnel-setup.md`.
- **Related issues:** [#114](https://github.com/jskjw157/gram-coding-agent/issues/114),
  [#121](https://github.com/jskjw157/gram-coding-agent/issues/121),
  [#129](https://github.com/jskjw157/gram-coding-agent/issues/129).
- **Verification method:** Check rendered unit command, trusted installed binary,
  configured loopback URL/header source, intended connector association and a
  successful documented `tunnel-client doctor` on the target.
- **Current implementation:** CONFIG ONLY. Official client selection is present
  in deployment templates; current target installation and connector behavior
  are not attested by repository text.
- **Current verification:** E-SOURCE;
  `tests/ops/systemd-contract.test.ts` contains a static contract only and was
  not executed. Live tunnel/connector acceptance NOT RUN.
- **Future automation:** AT-02: rendered-unit/configuration contract with actual
  test collection, binary provenance and secret-free target acceptance evidence.

## 4. Policy and task authority

### SEC-POL-001

**Protected branch history cannot be forcibly replaced or deleted.**

- **Rule:** DENY protected-branch force push, force-with-lease and deletion,
  including refspec/flag variants. Normal direct-main authorization must never
  override these prohibitions. Normal protected pushes require the appropriate
  explicit task grant/approval. Local protected-branch deletion is also forbidden
  as a desired safety property; current remote-ref checks do not establish it.
- **Actual source:** `packages/policy/src/risk-classifier.ts` —
  `classifyGit`, refspec parsing and protected-list lookup;
  `packages/git/src/command.ts`; `apps/agent/src/main.ts`.
- **Related issues:** [#57](https://github.com/jskjw157/gram-coding-agent/issues/57),
  [#110](https://github.com/jskjw157/gram-coding-agent/issues/110),
  [#115](https://github.com/jskjw157/gram-coding-agent/issues/115),
  [#191](https://github.com/jskjw157/gram-coding-agent/issues/191).
- **Verification method:** Run the real command boundary with a fake spawner
  and disposable Git fixture. All destructive protected variants must deny
  before consuming any approval or invoking Git, including with direct-main
  authorization. Verify the production protected list, not just injected tests.
- **Current implementation:** PARTIAL. Represented remote force/delete/mirror/
  wildcard operations are checked. The default protected set is `main/master`;
  production publishing does not discover all remote protected branches.
  Generic `git branch` allowance is not a local deletion guard.
- **Current verification:** E-SOURCE; command/refspec matrices in
  `packages/policy/src/policy-engine.test.ts` exist. Git global options,
  aliases/configuration, custom protections and local deletion are not thereby
  certified.
- **Future automation:** AT-03/AT-08: custom release/default branches, actual
  composition context, local deletion, bundled/global flags, multiple refspecs,
  aliases and approval-not-overriding-DENY cases.

### SEC-POL-002

**Unsupported shell semantics fail closed before authorization or execution.**

- **Rule:** Every executed shell effect must be modeled before classification/
  approval hashing or the request must fail closed. DENY wins across composition.
  Wrappers must not turn a denied inner command into an approvable or allowed one.
  Preserve intentional literal semantics for quoted/escaped text and direct argv.
- **Actual source:** `packages/policy/src/command-parser.ts` —
  `normalizeShellCommand`, `normalizeExecutableCommand`;
  `packages/policy/src/risk-classifier.ts`;
  `packages/shell/src/command-runner.ts` — `CommandRunner.run`.
- **Related issues:** [#153](https://github.com/jskjw157/gram-coding-agent/issues/153),
  [#187](https://github.com/jskjw157/gram-coding-agent/issues/187),
  [#191](https://github.com/jskjw157/gram-coding-agent/issues/191),
  [#192](https://github.com/jskjw157/gram-coding-agent/issues/192),
  [#116](https://github.com/jskjw157/gram-coding-agent/issues/116).
- **Verification method:** Drive parser plus real CommandRunner composition;
  unsupported input must cause zero approval consumption, command-run creation
  and spawn. Use literal decoy files when testing expansion; test executable-form
  arguments separately instead of expecting shell behavior there.
- **Current implementation:** PARTIAL. The four integrated fixes reject active
  redirects/substitutions, dynamic arguments and unmodeled separators. Existing
  supported composition is normalized. Recursive arbitrary shell-wrapper/code
  analysis is not implemented; opaque `sh/bash -c` falls to approval.
- **Current verification:** E-SOURCE;
  `packages/policy/src/policy-engine.test.ts` and
  `packages/shell/src/command-runner.test.ts` contain targeted regressions.
  Issue closure/E-CI does not prove complete Bash/Git/program semantics.
- **Future automation:** AT-03: preserve all four regression families, nested
  `sh/bash/env/sudo`, quote/escape tables, unsupported grammar, utility options
  and property/fuzz cases with a pre-spawn side-effect oracle.

### SEC-POL-003

**Approval is single-use and bound to the effective operation.**

- **Rule:** NEEDS_APPROVAL requires an unexpired, unused approval for the same
  task and security-relevant execution meaning. A different cwd/workspace,
  executable resolution, arguments, wrapper context or policy context must not
  reuse authorization. A grant cannot override DENY.
- **Actual source:** `packages/policy/src/policy-engine.ts` — `operationHash`;
  `packages/persistence/src/repositories/approval-repository.ts`;
  `packages/shell/src/command-runner.ts`;
  `apps/agent/src/main.ts` — approval composition.
- **Related issues:** [#23](https://github.com/jskjw157/gram-coding-agent/issues/23),
  [#49](https://github.com/jskjw157/gram-coding-agent/issues/49),
  [#191](https://github.com/jskjw157/gram-coding-agent/issues/191),
  [#115](https://github.com/jskjw157/gram-coding-agent/issues/115).
- **Verification method:** Request/approve/consume via the actual application
  ports, then change each effective-context field independently. Observe atomic
  single consumption across parallel attempts, expiry and wrong-task refusal.
- **Current implementation:** PARTIAL. Durable consumption binds task/hash,
  supports a 30-minute post-approval lifetime and prevents reuse. The hash binds
  normalized executable/args/canonical targets and branch/task context, but
  omits cwd, full wrapper context and executable/PATH identity. Human approver
  identity is a controller trust assumption, not an independent local check.
- **Current verification:** E-SOURCE;
  `packages/persistence/src/repositories/approval-repository.test.ts`,
  `apps/agent/src/approval-composition.test.ts`,
  `apps/agent/src/approval-scenario.test.ts` and policy hash tests exist.
  They do not establish full semantic binding.
- **Future automation:** AT-04: cwd/relative-script rebinding, changed workspace/
  lease, PATH/binary replacement, wrapper/environment changes and parallel
  consumption at the production boundary.

### SEC-POL-004

**Repository content and allowed programs cannot disable or bypass policy.**

- **Rule:** Normal task code, instructions, scripts, hooks and descendants must
  not disable Policy Engine, write its authority/configuration, dump credentials,
  or hide otherwise denied/approval-required actions. Sensitive operations must
  use an authorized task-bound adapter; unknown authority is not ALLOW.
- **Actual source:** `packages/policy/src/risk-classifier.ts`;
  `packages/shell/src/command-runner.ts`;
  `packages/repo-registry/src/repo-profiler.ts`;
  `apps/agent/src/verification-coordinator.ts`;
  `apps/agent/src/external-coding-capability.ts`.
- **Related issues:** [#49](https://github.com/jskjw157/gram-coding-agent/issues/49),
  [#114](https://github.com/jskjw157/gram-coding-agent/issues/114),
  [#116](https://github.com/jskjw157/gram-coding-agent/issues/116),
  [#119](https://github.com/jskjw157/gram-coding-agent/issues/119).
- **Verification method:** Execute disposable malicious repository scripts
  through the production verification path. Outside-worktree canaries, fake
  agent configuration and dummy secret stores must remain unchanged/unread;
  forbidden descendant launches must not occur.
- **Current implementation:** GAP beyond direct-spawn gating. Development
  tools/interpreters/package workflows are allowed; there is no child policy
  re-evaluation or OS filesystem/network/user sandbox. Coding APIs restrict
  configuration paths but do not constrain arbitrary program behavior.
- **Current verification:** E-SOURCE; direct gate tests exist in
  `packages/shell/src/command-runner.test.ts`; capability path tests exist in
  `apps/agent/src/external-coding-capability.test.ts`.
  Neither establishes malicious-script containment.
- **Future automation:** AT-05: interpreter, lifecycle script, Git hook/helper,
  login-profile and utility-option fixtures. Resolve the execution trust
  boundary explicitly before claiming this invariant.

### SEC-TASK-001

**Task mutation/review authority is active, correctly bound and replay-resistant.**

- **Rule:** Use canonical Task UUID identity; source mutation/review must match
  the recorded repository/workspace, current process-owned lease, active phase,
  unique step/review and expiry. Reject stale, cross-task, terminal, replaced
  workspace and already-consumed submissions before mutation or accepted PASS.
- **Actual source:** `packages/domain/src/task.ts`;
  `apps/agent/src/external-coding-capability.ts`;
  `apps/agent/src/external-verification-review.ts`;
  `packages/persistence/src/repositories/coding-step-repository.ts`;
  `packages/persistence/src/repositories/verification-review-repository.ts`.
- **Related issues:** [#18](https://github.com/jskjw157/gram-coding-agent/issues/18),
  [#159](https://github.com/jskjw157/gram-coding-agent/issues/159),
  [#115](https://github.com/jskjw157/gram-coding-agent/issues/115).
- **Verification method:** Use authenticated coding/review fixtures; swap every
  task/workspace/phase/run/lease identifier, replay submissions and interrupt
  between validation and application. Require no unauthorized write/PASS and
  preserve partially applied state for recovery.
- **Current implementation:** IMPLEMENTED in the exposed coding/review
  application adapters with durable claims and lease rechecks. IDs are not
  authentication credentials and there is no tenant-owner separation.
  Generic CommandRunner does not independently provide these bindings.
- **Current verification:** E-SOURCE;
  `apps/agent/src/external-coding-capability.test.ts`,
  `apps/agent/src/external-verification-review.test.ts`,
  `packages/persistence/src/repositories/coding-step-repository.test.ts` and
  `packages/persistence/src/repositories/verification-review-repository.test.ts`
  exist. Crash-atomic multi-file edits and live control are not established.
- **Future automation:** AT-06/AT-09: real process restart, simultaneous submits,
  lease replacement/loss between writes, partial IO and stale review replay.

## 5. Filesystem and Windows

### SEC-FS-001

**Ordinary task mutations stay inside the authorized task worktree.**

- **Rule:** Forbid normal task changes outside the recorded task worktree,
  including the canonical checkout, other tasks, host files and agent
  configuration/secrets. Validate traversal, canonical targets/ancestors, link
  behavior and stale preconditions. A separate privileged lifecycle operation
  needs its own explicit scope; a task ID or path conversion grants none.
- **Actual source:** `packages/filesystem/src/workspace-path-guard.ts`;
  `packages/filesystem/src/file-service.ts`;
  `packages/filesystem/src/patch-service.ts`;
  `packages/policy/src/worktree-path.ts`;
  `apps/agent/src/external-coding-capability.ts`;
  `apps/agent/src/verification-snapshot.ts`.
- **Related issues:** [#52](https://github.com/jskjw157/gram-coding-agent/issues/52),
  [#53](https://github.com/jskjw157/gram-coding-agent/issues/53),
  [#117](https://github.com/jskjw157/gram-coding-agent/issues/117),
  [#118](https://github.com/jskjw157/gram-coding-agent/issues/118).
- **Verification method:** Attempt traversal, absolute paths, symlink parents,
  hardlinks, special files and stale patch hashes through exposed APIs. Race
  ancestor replacement from a second process and run allowed scripts against
  external canary files; verify no outside bytes change.
- **Current implementation:** PARTIAL. Canonical path/nearest-parent checks exist.
  External coding adds strict source-path, link, size, lease and content checks.
  Generic FileService is weaker and pathname writes remain susceptible to
  same-user check/use races. Spawned task code is not filesystem-confined.
- **Current verification:** E-SOURCE;
  `packages/filesystem/src/workspace-path-guard.test.ts`,
  `packages/filesystem/src/file-service.test.ts`,
  `packages/policy/src/worktree-path.test.ts` and
  `apps/agent/src/external-coding-capability.test.ts` exist.
  Broad process/race safety is NOT verified.
- **Future automation:** AT-05/AT-06: descriptor/ancestor races, cross-task links,
  hardlinks/FIFOs, optional read-command argument safety and script canaries.

### SEC-WIN-001

**Raw PowerShell/CMD/Windows executable execution requires approval.**

- **Rule:** Raw `powershell.exe`, `pwsh.exe`, `cmd.exe` and arbitrary Windows
  executable requests require valid task-bound approval before spawn. A wrapper,
  interpreter or repository script must not bypass the intended boundary.
- **Actual source:** `packages/policy/src/risk-classifier.ts` —
  `POL-WIN-RAW-EXEC`; `packages/shell/src/command-runner.ts`;
  `apps/agent/src/main.ts` — approval consumption.
- **Related issues:** [#103](https://github.com/jskjw157/gram-coding-agent/issues/103),
  [#112](https://github.com/jskjw157/gram-coding-agent/issues/112),
  [#115](https://github.com/jskjw157/gram-coding-agent/issues/115).
- **Verification method:** Observe no spawn for raw Windows requests without a
  matching approval, then exactly one authorized invocation. Also invoke a
  Windows-child fixture through an allowed interpreter/package script.
- **Current implementation:** PARTIAL. Direct recognized executable requests
  are approval-gated. Descendant execution is not covered by top-level policy;
  approval meaning also has the SEC-POL-003 limitations.
- **Current verification:** E-SOURCE;
  `packages/policy/src/policy-engine.test.ts`,
  `packages/shell/src/command-runner.test.ts` and
  `apps/agent/src/approval-scenario.test.ts` exist.
  Real Windows execution and descendant containment NOT RUN.
- **Future automation:** AT-04/AT-05/AT-07: Windows path/case/alias variants,
  nested wrappers, script child launches, expiry, replay and wrong-task grants.

### SEC-WIN-002

**Typed Windows operations never expose arbitrary execution.**

- **Rule:** No generic `windows_exec(command)`. Typed path/open/reveal/clipboard
  inputs cannot choose executable, switches or script text. Fixed adapters
  separate data from code; validate supported paths/URI schemes. Clipboard is
  text-only, bounded to the planned 1 MiB, redacted and absent from audit bodies.
- **Actual source:** `packages/mcp/src/server.ts` — current registry contains no
  Windows tools; `packages/policy/src/risk-classifier.ts` — raw-exec guard.
  There is **no typed Windows implementation** at the baseline. Its requirement
  source is `docs/superpowers/plans/2026-09-15-m4-windows-integration-ux.md`.
- **Related issues:** [#100](https://github.com/jskjw157/gram-coding-agent/issues/100),
  [#101](https://github.com/jskjw157/gram-coding-agent/issues/101),
  [#102](https://github.com/jskjw157/gram-coding-agent/issues/102),
  [#112](https://github.com/jskjw157/gram-coding-agent/issues/112).
- **Verification method:** Enumerate registered tools and attack strict input
  schemas with command/executable/args/script fields. Spy on fixed argv/stdin,
  test disallowed URI schemes and bound/redact clipboard data at every sink.
- **Current implementation:** PLANNED. Absence of an unsafe generic tool is
  source-observed; it does not establish safety of future typed tools.
- **Current verification:** E-SOURCE registry inspection only. Existing
  `packages/mcp/src/tools/tools-contract.test.ts` is not a Windows-tool test.
  No typed-tool or clipboard security tests exist at this baseline.
- **Future automation:** AT-07/AT-11: planned Windows escape suite, schema
  rejection, quotes/newlines/subexpressions, input bounds, safe URI/path data,
  clipboard synthetic secrets and metadata-only audit.

### SEC-WIN-003

**Path conversion uses fixed direct argv and grants no extra authority.**

- **Rule:** Convert dynamically using installed `wslpath` with fixed mode and
  one validated path argument; never interpolate shell text or use
  `shell: true`. Reject NUL, excessive length and malformed input/output.
  Conversion alone cannot authorize reads, writes or execution.
- **Actual source:** `packages/workspace/src/path-mapper.ts` —
  `PathMapper.toWindows`; `apps/agent/src/command-adapters.ts` —
  `PolicyWslPathRunner`; `packages/policy/src/risk-classifier.ts`;
  `packages/shell/src/command-runner.ts`.
- **Related issues:** [#47](https://github.com/jskjw157/gram-coding-agent/issues/47),
  [#99](https://github.com/jskjw157/gram-coding-agent/issues/99),
  [#102](https://github.com/jskjw157/gram-coding-agent/issues/102).
- **Verification method:** Observe exact executable/argv and no shell invocation;
  test literal metacharacters, invalid inputs, nonzero exit and invalid output.
  Run both conversion directions against real installed WSL tooling later.
- **Current implementation:** PARTIAL. Existing `-w` conversion checks empty
  input/output and uses direct argv. Bidirectional WindowsPathService,
  comprehensive input bounds and M4 typed exposure are absent at this SHA.
- **Current verification:** E-SOURCE;
  `packages/workspace/src/path-mapper.test.ts` and
  `apps/agent/src/command-adapters.test.ts` exist, with adapter/fake conversion
  evidence only. Real WSL conversion NOT RUN.
- **Future automation:** AT-07: both directions, spaces/Unicode/UNC forms,
  NUL/oversize/invalid paths, mode-option confusion and real WSL smoke evidence.

## 6. Repository mutation locks and recovery

### SEC-LOCK-001

**PR/CI observation must not own the repository mutation lease.**

- **Rule:** Release the observing task's mutation lease before PR create/reuse
  and CI observation. Those operations must not reacquire or retain it.
  A repair must reacquire before mutation. Another task may legitimately hold
  the same repository's lease while the first observes CI.
- **Actual source:** `packages/task-engine/src/task-runner.ts` —
  `run`, `runRepairCycle`; `apps/agent/src/task-runner-composition.ts`;
  `packages/github/src/pull-request-service.ts`;
  `packages/github/src/checks-service.ts`.
- **Related issues:** [#63](https://github.com/jskjw157/gram-coding-agent/issues/63),
  [#65](https://github.com/jskjw157/gram-coding-agent/issues/65),
  [#67](https://github.com/jskjw157/gram-coding-agent/issues/67),
  [#94](https://github.com/jskjw157/gram-coding-agent/issues/94),
  [#115](https://github.com/jskjw157/gram-coding-agent/issues/115).
- **Verification method:** Inspect lease owner at every PR/check request,
  pagination and retry. During Task A observation, Task B must be able to
  acquire/mutate the same repository. Restart after confirmed push must not
  reacquire merely to resume observation.
- **Current implementation:** IMPLEMENTED normal orchestration and package
  separation. Repair-cycle abstraction requires reacquisition; production main
  does not wire its repair mutation/remote capability and fails closed there.
  Package import absence alone is not runtime proof.
- **Current verification:** E-SOURCE;
  `packages/github/src/architecture-boundary.test.ts`,
  `packages/task-engine/src/task-runner-run.test.ts`,
  `packages/task-engine/src/task-runner.test.ts`,
  `tests/e2e/vertical-slice.test.ts` exist. The E2E uses local Git/SQLite and a
  fake GitHub provider; live/concurrent restart acceptance NOT RUN.
- **Future automation:** AT-09/AT-10: observer-owner assertions, A-observes/B-
  mutates concurrency, restart-before-PR, and durable local observation times.

### SEC-LOCK-002

**Exact remote SHA confirmation must precede mutation-lock release.**

- **Rule:** Normal publishing may release its mutation lease only after the
  exact inspected full commit SHA is confirmed at the named remote branch and
  confirmation is persisted. Push exit code, branch existence, abbreviated SHA
  or confirmation of another ref is insufficient. Failures retain uncertain work.
- **Actual source:** `packages/publishing/src/publishing-service.ts` —
  `publish`; `packages/git/src/remote-service.ts` —
  `push`, `confirmRemoteSha`;
  `packages/persistence/src/repositories/git-commit-repository.ts`;
  `apps/agent/src/task-runner-composition.ts`.
- **Related issues:** [#57](https://github.com/jskjw157/gram-coding-agent/issues/57),
  [#61](https://github.com/jskjw157/gram-coding-agent/issues/61),
  [#62](https://github.com/jskjw157/gram-coding-agent/issues/62),
  [#69](https://github.com/jskjw157/gram-coding-agent/issues/69).
- **Verification method:** Record commit, push, SHA/ref readback, persisted
  confirmation and release in order. Inject false/missing/malformed confirmation
  and persistence/audit failures; assert no early release or subsequent PR/CI.
- **Current implementation:** IMPLEMENTED in normal publishing composition:
  immutable SHA push, exact SHA/ref equality, persisted confirmation then release.
  Low-level `lease.release()` has no confirmation predicate. Remote repository
  identity is a separate unresolved SEC-GIT-001 concern; crash atomicity is not
  implied by source ordering.
- **Current verification:** E-SOURCE;
  `packages/publishing/src/publishing-service.test.ts`,
  `packages/publishing/src/publishing-persistence.test.ts`,
  `packages/git/src/remote-service.test.ts`,
  `packages/git/src/git-service.test.ts` and
  `tests/e2e/vertical-slice.test.ts` exist. Real-Git tests use disposable local
  remotes; live GitHub/process-kill evidence NOT RUN.
- **Future automation:** AT-08/AT-09: wrong ref/right SHA, wrong SHA/right ref,
  multiple records, remote retargeting, persistence failure and every crash
  window from push through release/PR.

### SEC-LOCK-003

**Only the current repository owner may mutate, including after lease loss.**

- **Rule:** Serialize same-repository mutations by immutable repository ID and
  current task/token ownership; allow independent repositories concurrently.
  Replaced or lost ownership must fence the former owner and its child processes.
  Lease expiration requires ownership/process revalidation; expiry alone must
  not transfer ownership or authorize deletion of uncertain work. The M3 plan's
  same-boot/live-PID case is ACTIVE_BUT_HEARTBEAT_LATE, not automatically stale.
- **Actual source:** `packages/repo-lock/src/repo-lock-service.ts`;
  `packages/repo-lock/src/lease-heartbeat.ts`;
  `packages/persistence/src/repositories/lock-repository.ts`;
  `apps/agent/src/main.ts`; `apps/agent/src/external-coding-capability.ts`.
- **Related issues:** [#43](https://github.com/jskjw157/gram-coding-agent/issues/43),
  [#44](https://github.com/jskjw157/gram-coding-agent/issues/44),
  [#45](https://github.com/jskjw157/gram-coding-agent/issues/45),
  [#91](https://github.com/jskjw157/gram-coding-agent/issues/91),
  [#92](https://github.com/jskjw157/gram-coding-agent/issues/92),
  [#93](https://github.com/jskjw157/gram-coding-agent/issues/93).
- **Verification method:** Competing processes acquire the same/different repo
  leases; replace token/boot identity or lose heartbeat during a child write.
  Assert one valid owner, no post-loss writes and preserved ambiguous state.
- **Current implementation:** PARTIAL. Exclusive `wx` lock file, immediate
  SQLite acquisition, token-bound heartbeat, held-lease tracking and
  NEEDS_RECOVERY marking exist. Generic spawned children have no lease-fencing
  or termination interface; boot/stale reconciliation is not implemented.
- **Current verification:** E-SOURCE;
  `packages/repo-lock/src/repo-lock-service.test.ts`,
  `packages/repo-lock/src/lease-heartbeat.test.ts` and capability tests exist.
  Same-process calls/fake timers are not multiprocess crash proof.
- **Future automation:** AT-09: OS-process contention, late heartbeat with live
  owner, PID reuse/reboot, database/file disagreement and child-tree fencing.

### SEC-LOCK-004

**Uncertain, dirty and unpushed work survives interruption and cleanup.**

- **Rule:** Reconcile interrupted owners/workspaces before admitting conflicting
  mutation. Ambiguous non-idempotent effects require recovery, not silent replay.
  Dirty, unconfirmed/unpushed, approval-blocked or recovery-blocked worktrees
  cannot be automatically deleted, including under disk pressure.
- **Actual source:** `apps/agent/src/main.ts` — shutdown;
  `packages/repo-lock/src/repo-lock-service.ts` — `quiesce`;
  `packages/task-engine/src/task-runner.ts`;
  `packages/persistence/src/repositories/workspace-repository.ts`.
  Future requirements are in
  `docs/superpowers/plans/2026-09-15-m3-reliability-recovery.md`.
- **Related issues:** [#82](https://github.com/jskjw157/gram-coding-agent/issues/82),
  [#88](https://github.com/jskjw157/gram-coding-agent/issues/88),
  [#89](https://github.com/jskjw157/gram-coding-agent/issues/89),
  [#90](https://github.com/jskjw157/gram-coding-agent/issues/90),
  [#93](https://github.com/jskjw157/gram-coding-agent/issues/93),
  [#94](https://github.com/jskjw157/gram-coding-agent/issues/94).
- **Verification method:** Kill/restart during each mutation/publish step; use
  dirty/untracked/unpushed/recovery fixtures and disk-pressure cleanup. Require
  evidence-led reconciliation and no deletion/replay on uncertain outcome.
- **Current implementation:** PARTIAL/PLANNED. Graceful shutdown preserves
  unconfirmed leases and interrupts pending controller work. Boot recovery
  coordinator, stale-lock reconciler and janitor are absent. An interrupted
  coding step is not proof of a recovered Task.
- **Current verification:** E-SOURCE; `apps/agent/src/main.test.ts`,
  `packages/repo-lock/src/repo-lock-service.test.ts` and
  `apps/agent/src/external-coding-capability.test.ts` contain narrow shutdown/
  interruption definitions. No full crash/reboot/cleanup acceptance.
- **Future automation:** AT-09/AT-12: crash/reboot state matrix, post-confirm
  restart without observation lock, retain dirty/unpushed work and recheck
  cleanup eligibility immediately before any deletion.

## 7. GitHub and publishing evidence

### SEC-GIT-001

**Credential use and remote destination remain narrowly bound.**

- **Rule:** Use credentials only inside their intended Git/GitHub adapter and
  for the intended repository/provider. Never expose credential values or
  follow a credential-bearing request to an unapproved origin. Before pushing/
  confirming, bind the actual remote to the registry's intended repository.
- **Actual source:** `packages/github/src/github-client.ts`;
  `apps/agent/src/github-services.ts`;
  `packages/secrets/src/file-secret-provider.ts`;
  `packages/git/src/remote-service.ts`;
  `apps/agent/src/persistence-adapters.ts`.
- **Related issues:** [#57](https://github.com/jskjw157/gram-coding-agent/issues/57),
  [#63](https://github.com/jskjw157/gram-coding-agent/issues/63),
  [#114](https://github.com/jskjw157/gram-coding-agent/issues/114),
  [#120](https://github.com/jskjw157/gram-coding-agent/issues/120).
- **Verification method:** Instrument credential leases/disposal, HTTP targets,
  redirects/errors and Git configuration in disposable fixtures. Retarget
  origin and introduce dummy helpers; require refusal before any unintended
  network effect or disclosure.
- **Current implementation:** PARTIAL. GitHub HTTP uses request-scoped leases,
  fixed production API origin, redirect refusal and bounded transport.
  Git CLI push uses `origin`; exact SHA/ref readback does not validate origin
  against the registered GitHub repository ID. Actual token scopes and ambient
  Git helpers remain deployment/execution concerns.
- **Current verification:** E-SOURCE;
  `packages/github/src/github-client.test.ts`,
  `apps/agent/src/github-services.test.ts`,
  `packages/secrets/src/file-secret-provider.test.ts` and
  `tests/e2e/check-observation.test.ts` exist. HTTP fixtures and local Git do
  not prove real credential scope or hostile-config isolation.
- **Future automation:** AT-08/AT-11: destination identity, origin/config
  replacement, redirect/parse-error canaries, lease disposal and scoped target
  credential evidence without secret values.

### SEC-GIT-002

**Only exact, evidence-backed content may be published.**

- **Rule:** Publish only explicitly reviewed paths/bytes from the same task,
  registered workspace, plan, HEAD and sealed snapshot with required evidence.
  Revalidate before commit and inspect the created commit before pushing its
  immutable SHA. Missing/stale/mismatched evidence must fail closed.
- **Actual source:** `apps/agent/src/verified-publishing.ts`;
  `apps/agent/src/verification-snapshot.ts`;
  `apps/agent/src/verification-coordinator.ts`;
  `apps/agent/src/external-verification-review.ts`;
  `packages/verification/src/verification-runner.ts`;
  `packages/publishing/src/publishing-service.ts`.
- **Related issues:** [#56](https://github.com/jskjw157/gram-coding-agent/issues/56),
  [#61](https://github.com/jskjw157/gram-coding-agent/issues/61),
  [#158](https://github.com/jskjw157/gram-coding-agent/issues/158),
  [#159](https://github.com/jskjw157/gram-coding-agent/issues/159).
- **Verification method:** Change HEAD, bytes, mode, workspace, review/plan
  identity or hook-created commit content between each stage. Require zero push
  on mismatch and verify successful push uses the inspected full SHA.
- **Current implementation:** IMPLEMENTED normal production binding, including
  mandatory composition of the low-level optional committed-content hook.
  Secret-scan/diff-review PASS is authenticated external-controller attestation
  with read/digest acknowledgement, not independent judgment or a comprehensive
  built-in scanner. Snapshot consistency is not OS isolation.
- **Current verification:** E-SOURCE;
  `apps/agent/src/verified-publishing.test.ts`,
  `apps/agent/src/verification-snapshot.test.ts`,
  `packages/verification/src/snapshot-sealing.test.ts`,
  `tests/e2e/verification-review-flow.test.ts` exist.
  Fixtures do not certify controller review quality or live acceptance.
- **Future automation:** AT-08: concurrent content drift, hook/filter changes,
  stale/replayed/foreign review evidence, unread-file PASS attempts and exact
  bytes/ref confirmation through production composition.

### SEC-GIT-003

**CI completion evidence is bound to the published task and exact SHA.**

- **Rule:** Complete a task only from persisted, exact-SHA required-check
  evidence for its intended repo/PR. Missing, pending, failing, stale or unknown
  required evidence cannot become a successful completion; unsupported provider
  policy must fail closed. Observation does not mutate repository state.
- **Actual source:** `packages/github/src/checks-client.ts`;
  `packages/github/src/checks-service.ts`;
  `apps/agent/src/persistence-adapters.ts` — `PersistentCiContextResolver`;
  `apps/agent/src/github-services.ts`;
  `packages/persistence/src/repositories/ci-run-repository.ts`;
  `packages/persistence/src/migrations/001_initial.sql`.
- **Related issues:** [#65](https://github.com/jskjw157/gram-coding-agent/issues/65),
  [#66](https://github.com/jskjw157/gram-coding-agent/issues/66),
  [#77](https://github.com/jskjw157/gram-coding-agent/issues/77),
  [#115](https://github.com/jskjw157/gram-coding-agent/issues/115).
- **Verification method:** Feed wrong SHA/app/name, missing pages/checks,
  duplicate reruns, failure/pending and unknown status data; require correct
  persisted attribution and no false completion. Move the remote PR head during
  observation and distinguish historical task evidence from current mergeability.
- **Current implementation:** IMPLEMENTED supported subset/PARTIAL broader
  integration. Exact SHA/check matching, pagination and conservative state
  handling occur during provider ingestion. Persisted CI rows have no own
  commit SHA/commit ID or required-rule/app binding, so rows alone cannot
  reconstruct that historical association after another publish or recovery.
  This is a durable evidence gap, not a demonstrated wrong-SHA completion in the
  normal observed flow. Production refuses active rulesets and legacy statuses
  rather than implementing their full semantics. Mutable PR-head behavior
  remains a separate acceptance concern.
- **Current verification:** E-SOURCE;
  `packages/github/src/checks-client.test.ts`,
  `packages/github/src/checks-service.test.ts`,
  `packages/github/src/checks-persistence.test.ts`,
  `tests/e2e/check-observation.test.ts` exist. Provider fixtures are not live
  GitHub policy validation.
- **Future automation:** AT-10: remote head movement, duplicates across pages,
  app identity, unsupported rules/statuses and local observation evidence.
  Multiple publishes/restart for one task must not rebind historical checks to
  the latest commit; preserve durable SHA/required-rule association.
  Do not substitute provider start times for the agent's actual observe time.

## 8. Secret and operational boundaries

### SEC-SEC-001

**No generic secret-read operation.**

- **Rule:** Do not expose `secret_get`, arbitrary secret-file reads or equivalent
  generic credential-returning MCP APIs. Specialized adapters may use a scoped
  credential internally and return only secret-free status/results.
- **Actual source:** `packages/mcp/src/server.ts`;
  `packages/secrets/src/secret-provider.ts`;
  `packages/secrets/src/file-secret-provider.ts`;
  `packages/github/src/github-client.ts`.
- **Related issues:** [#19](https://github.com/jskjw157/gram-coding-agent/issues/19),
  [#115](https://github.com/jskjw157/gram-coding-agent/issues/115),
  [#120](https://github.com/jskjw157/gram-coding-agent/issues/120).
- **Verification method:** Enumerate production MCP tools and responses; require
  no generic credential-returning route. Spy on specialized use/dispose and
  ensure the token never enters returned structures/errors.
- **Current implementation:** IMPLEMENTED narrow surface/property: no generic
  secret getter is registered and internal credential leases exist. This does
  not prove ordinary processes cannot read same-user secret files.
- **Current verification:** E-SOURCE;
  `packages/mcp/src/tools/tools-contract.test.ts`,
  `packages/secrets/src/file-secret-provider.test.ts` and
  `packages/github/src/github-client.test.ts` exist. Broader sink/access proof
  belongs to SEC-SEC-002/003.
- **Future automation:** AT-11/AT-14: production tool-enumeration guard and
  canaries for all specialized credential-use success/error responses.

### SEC-SEC-002

**No secret values in Git, logs, SQLite or MCP responses.**

- **Rule:** Reject, omit or redact secret values before every durable or
  externally visible sink: task input/metadata, command argv/cwd/output,
  audits/errors, Git metadata/content, logs, SQLite/WAL and MCP results/errors.
  Redaction after persistence or after an external disclosure is too late.
- **Actual source:** `packages/secrets/src/redactor.ts`;
  `packages/observability/src/logger.ts`;
  `packages/shell/src/output-capture.ts`;
  `packages/task-engine/src/task-service.ts`;
  `packages/persistence/src/repositories/task-repository.ts`;
  `packages/persistence/src/repositories/audit-repository.ts`;
  `packages/mcp/src/tools/task-tools.ts`;
  `apps/agent/src/task-scheduler.ts`; `apps/agent/src/main.ts`.
- **Related issues:** [#19](https://github.com/jskjw157/gram-coding-agent/issues/19),
  [#50](https://github.com/jskjw157/gram-coding-agent/issues/50),
  [#101](https://github.com/jskjw157/gram-coding-agent/issues/101),
  [#120](https://github.com/jskjw157/gram-coding-agent/issues/120).
- **Verification method:** Send synthetic secrets through task_create, command
  text/argv/cwd, output, exceptions, reviews and provider/clipboard data. Scan
  all resulting SQLite tables/WAL, command files, structured logs, Git content/
  metadata and MCP success/error payloads; no canary may survive.
- **Current implementation:** PARTIAL with identified GAPs. Logger/output paths
  redact known values, but task_create stores/returns goal/repo without a secret
  boundary; AuditRepository serializes arbitrary payloads; scheduler failure
  audit stores raw errors. Main exactly registers the internal secret only.
  Common-pattern redaction is not universal credential coverage.
- **Current verification:** E-SOURCE;
  `packages/secrets/src/redactor.test.ts`,
  `packages/observability/src/logger.test.ts`,
  `packages/shell/src/command-evidence.test.ts`,
  `packages/task-engine/src/task-service.test.ts` exist.
  The minimized TASK_CREATED audit test does not prove secret-free tasks or
  task_create responses. Global no-leak verification is NOT established.
- **Future automation:** AT-11: full ingress-to-sink matrix, every registered
  secret, arbitrary-shaped/encoded/fragmented canaries, failure paths and
  metadata/commit-message leaks. Keep source-review capture tests separate.

### SEC-SEC-003

**Generic task execution cannot obtain high-value credentials.**

- **Rule:** Ordinary task children must not receive GitHub, tunnel, internal MCP
  or administrator credentials through environment or ambient readable stores/
  helpers. Credential use is confined to dedicated adapters, with no runtime
  admin credential allowed even in those adapters.
- **Actual source:** `packages/shell/src/command-runner.ts` —
  `buildSafeCommandEnvironment`, `NodeProcessSpawner`;
  `packages/secrets/src/file-secret-provider.ts`;
  `apps/agent/src/github-services.ts`.
- **Related issues:** [#50](https://github.com/jskjw157/gram-coding-agent/issues/50),
  [#119](https://github.com/jskjw157/gram-coding-agent/issues/119),
  [#120](https://github.com/jskjw157/gram-coding-agent/issues/120).
- **Verification method:** Seed fake `GITHUB_TOKEN`, `CONTROL_PLANE_API_KEY`,
  `GRAM_MCP_INTERNAL_SECRET`, `OPENAI_ADMIN_KEY`; inspect the spawned fixture's
  environment and attempted access to dummy secret files/helpers/startup files.
  Use canary outcomes, not real credential printing.
- **Current implementation:** PARTIAL. Environment allowlist omits those keys.
  HOME/PATH remain, shellText runs login Bash, and children use the ordinary
  runtime user. Mode `0600` protects from other users, not the same user.
  No ambient-access/descendant isolation is established.
- **Current verification:** E-SOURCE;
  `packages/shell/src/command-evidence.test.ts` and
  `packages/secrets/src/file-secret-provider.test.ts` exist.
  Environment exclusion is not credential-file isolation or key-scope proof.
- **Future automation:** AT-02/AT-05/AT-11: environment, HOME/PATH/login files,
  Git helpers, same-user dummy stores and descendant acquisition attempts.

### SEC-DB-001

**State integrity and restore must fail safely.**

- **Rule:** Corrupt/inconsistent state must prevent normal task mutation until
  reconciled. Persist short transactions outside external command execution.
  Backups/restores must preserve consistent SQLite/WAL state and identities;
  never treat a live main-db-only copy as a verified backup.
- **Actual source:** `packages/persistence/src/database.ts`;
  `packages/persistence/src/migrator.ts`;
  `packages/persistence/src/repositories/lock-repository.ts`;
  `packages/persistence/src/repositories/task-repository.ts`;
  `apps/agent/src/main.ts`.
- **Related issues:** [#51](https://github.com/jskjw157/gram-coding-agent/issues/51),
  [#123](https://github.com/jskjw157/gram-coding-agent/issues/123),
  [#124](https://github.com/jskjw157/gram-coding-agent/issues/124).
- **Verification method:** Corrupt copied database/WAL fixtures and introduce
  partial storage failures; require scheduling refusal and preserved evidence.
  Take an online consistent backup, restore to a new location, verify integrity/
  migrations/identities, and prove no external command runs inside a DB transaction.
- **Current implementation:** PARTIAL/PLANNED. WAL, foreign keys, busy timeout,
  immediate migrations/acquisition and guarded task transitions exist. Dedicated
  integrity gate, online backup and safe restore services are absent. An open
  database/healthy status is not an integrity result.
- **Current verification:** E-SOURCE;
  `packages/persistence/src/migrator.test.ts`,
  `packages/persistence/src/repositories/task-repository.test.ts` and
  `packages/shell/src/command-evidence.test.ts` exist.
  Migration rollback/evidence tests are not physical corruption/backup tests.
- **Future automation:** AT-12: damaged copied DB/WAL, disk-full transactions,
  concurrent online backup, verified restore, identity round trip and safe
  recovery-before-scheduling.

### SEC-OPS-001

**Output, persistent storage and process lifetime are bounded.**

- **Rule:** Untrusted command output must not grow memory/logs without bound;
  redact before sinks, record truncation, bound retention and execution/
  shutdown deadlines. Timeout/termination must not falsely declare success or
  discard uncertain work/leases.
- **Actual source:** `packages/shell/src/command-runner.ts`;
  `packages/shell/src/output-capture.ts`;
  `packages/observability/src/logger.ts`;
  `apps/agent/src/verification-review-command.ts`;
  `apps/agent/src/main.ts`.
- **Related issues:** [#122](https://github.com/jskjw157/gram-coding-agent/issues/122),
  [#125](https://github.com/jskjw157/gram-coding-agent/issues/125),
  [#130](https://github.com/jskjw157/gram-coding-agent/issues/130).
- **Verification method:** Use bounded fixtures that exceed output thresholds,
  hang, spawn children or encounter full disks. Measure memory/time/file bounds,
  safe truncation metadata, process exit and retained recovery state.
- **Current implementation:** PARTIAL/GAP. Dedicated fixed Git review reads
  have a 10-second default timeout, 256 KiB per-stream cap and metadata-only
  source capture. Generic NodeProcessSpawner accumulates unbounded strings and
  has no timeout/child-tree control; general log rotation is absent.
  M5's 25 MiB/10-file log and 100 MiB command limits are planned, not defaults
  already implemented in the generic runner.
- **Current verification:** E-SOURCE;
  `apps/agent/src/verification-review-command.test.ts`,
  `packages/shell/src/command-evidence.test.ts` and
  `apps/agent/src/main.test.ts` exist. Narrow review/shutdown fixtures do not
  prove bounded arbitrary task execution.
- **Future automation:** AT-13: streaming caps, redaction across chunks,
  truncation/retention, kill-and-wait/child-tree behavior, hung shutdown and
  disk-full recovery without premature lease release.

## 9. Future automation backlog — not implemented by this draft

AT IDs group planned scenarios; they do not rename SEC requirements or claim
that a future test file already exists. All scenarios must exercise production
application/MCP boundaries where available, in addition to focused pure tests.
Use synthetic credentials, disposable processes/repositories and external
canaries. Expected failure assertions must observe side effects, not only a
classifier return value.

| Automation | Required scenarios | SEC coverage | Planned destination / dependency |
| --- | --- | --- | --- |
| AT-01 | Listener addresses, Host/auth header matrix, no dispatch, health and error canaries | SEC-MCP-001, SEC-MCP-002 | M5 `tests/security/mcp-auth.test.ts` (absent); #121 |
| AT-02 | Rendered official tunnel configuration, parent/child/admin key exclusion, effective target scope evidence | SEC-TUN-001, SEC-TUN-002, SEC-SEC-003 | M5 auth/env suite plus target operator evidence; #119/#121 |
| AT-03 | Existing four parser regressions, nested wrappers, unknown grammar, Git variants and unconditional DENY | SEC-POL-001, SEC-POL-002, SEC-POL-004 | M5 `tests/security/command-bypass.test.ts` (absent); #116 |
| AT-04 | Exact context binding, cwd/PATH/workspace changes, wrong task, expiry, duplicate/parallel consumption | SEC-POL-003, SEC-WIN-001 | Future command/approval regression expansion; #115/#116 |
| AT-05 | Malicious scripts/hooks/interpreters/utility options; outside-file, credential and Windows-child canaries | SEC-POL-004, SEC-FS-001, SEC-WIN-001, SEC-SEC-003 | Future execution-isolation tests and architecture decision; #114/#116/#119 |
| AT-06 | Path traversal, symlink/hardlink/FIFO and ancestor races, stale patches, task/step replay | SEC-TASK-001, SEC-FS-001 | M5 `tests/security/path-traversal.test.ts` and `tests/security/symlink-escape.test.ts` (absent); #117/#118 |
| AT-07 | Bidirectional path conversion; strict typed-tool schemas; fixed argv/stdin; clipboard and raw-shell acceptance | SEC-WIN-001, SEC-WIN-002, SEC-WIN-003 | M4 `tests/security/windows-escape.test.ts` (absent), future Windows package; #99–#103/#111/#112 |
| AT-08 | Protected branch/remote identity, immutable verified commit, exact readback and persistence-before-release | SEC-POL-001, SEC-GIT-001, SEC-GIT-002, SEC-LOCK-002 | Existing publishing/Git tests to extend; #57/#62/#110 |
| AT-09 | Multiprocess locks, live stale owner, boot/PID/token mismatch, child fencing, kill/restart and retained work | SEC-TASK-001, SEC-LOCK-001, SEC-LOCK-002, SEC-LOCK-003, SEC-LOCK-004 | M3 crash/concurrency/recovery tests; #79–#94 |
| AT-10 | A-observes/B-mutates, PR/head drift, exact-SHA checks, pagination, multiple publishes/restart with durable SHA/rule binding, local observation times | SEC-LOCK-001, SEC-GIT-003 | CI/restart evidence tests; #65/#66/#77/#94 |
| AT-11 | Full ingress-to-sink synthetic-secret sweep, exact registration, adapter errors, dummy credential stores | SEC-MCP-002, SEC-TUN-001, SEC-GIT-001, SEC-WIN-002, SEC-SEC-001, SEC-SEC-002, SEC-SEC-003 | M5 `tests/security/env-injection.test.ts` and `tests/security/secret-exposure.test.ts` (absent); #119/#120 |
| AT-12 | Corrupt DB/WAL, safe online backup/restore, full disk, retention/recovery before scheduling | SEC-DB-001, SEC-LOCK-004 | M5 integrity/backup tests (production services absent); #123/#124 |
| AT-13 | Stream/file/process bounds, source omission, chunk redaction, timeout/child-tree shutdown and uncertainty | SEC-OPS-001 | Future generic output/log/process tests; #122 |
| AT-14 | Required suite collection, nonzero test counts, SEC-ID coverage, real tool enumeration and acceptance records | All SEC IDs | Future test/CI registration and #130; no CI/config change in this draft |

## 10. Revalidation and acceptance record contract

For current repository tests, `pnpm test` collects the package/application
projects and `pnpm test:e2e` uses the separate E2E configuration. These are
revalidation entry points, not commands executed in this documentation task.
Do not advertise `pnpm test:security` as available until its script, collection
and nonzero required-case checks are implemented in an authorized later change.

Before future acceptance, re-read these two documents against the actual
integration SHA after #112; update source paths and statuses without rewriting
what the pinned M2 evidence proved. Each SEC result must record:

| Field | Required evidence |
| --- | --- |
| Identity | SEC ID, tested commit, scenario/test name, application entry point |
| Environment | Runtime/OS; fixture, local integration or real Windows/WSL/provider |
| Expected/observed | Allowed/forbidden behavior, concrete side-effect assertions and result |
| Artifact | Test/run log or secret-free target record and collection count |
| Limits | Untested branches, trust assumptions, unresolved gaps and related issues |
| Acceptance | Explicit reviewer decision after prerequisite gates; no automatic promotion from CI |

Unimplemented or untested High/Critical controls remain blockers for #130.
This draft changes only `docs/security/threat-model.md` and
`docs/security/policy-invariants.md`; it neither implements this backlog nor
changes source, tests, CI, account/system settings, issue states or release gates.
