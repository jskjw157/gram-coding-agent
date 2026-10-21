# M2/M5 final completion execution record

Scope: preserve TASK-000005/6 and all historical worktrees; fix actual command
credential acquisition, collect security checks in required CI, validate a new
integration SHA, and repeat live acceptance where external gates permit. No
main merge, release, billing/access change, or cleanup of historical evidence.

Baseline: M2 integration `173a3d0d3d1ddd983eb3d6de86ed2d27e19c82d9`,
main `ba9fc6814711e983a11e58a09ed04e8337a4effe`; PR #206/#208/#211 are
merged only into this independent development branch, not main or their source
branches. PR #215 is an integration preview and must not be merged in addition
to its component stack. Historical #217 remains unchanged.

## Work and gates

1. Read approved architecture, M2/M5 plans, #77/#119, #206/#208/#211 and runtime.
2. Reproduce #208 unchanged: native WSL, UID 1000, Node 24.21.0, **3 PASS /
   3 FAIL**; `m5-baseline-red-20261020.log` retains the actual output.
3. Develop a fail-closed Linux Node command profile and separate ordinary
   verification execution from trusted application Git capabilities. Preserve
   the original file-denial assertions and real provider/executable controls.
4. Implement and test the actual namespace/LSM/FD/syscall boundary; test
   descendants, npm, shell startup, host paths/proc/FD/socket/Windows routes,
   lifetime and setup failure. Independently review and repair.
5. Complete Git execution/credential safety and collect security in required CI;
   run lint/typecheck/unit/E2E/build/security on the actual final candidate.
6. Recheck private capability; if unavailable retain exact API evidence, do not
   alter plan/protection/billing. Repeat only permissible live acceptance with
   backups, idle/lock checks, bounded activation and restoration.
7. Publish reviewed Draft PRs, exact-SHA CI, integration/rollback/evidence reports.

## Decisions and limits

- The installed skill catalogs and plugin search contain no `goal/SKILL.md`.
  `ultragoal` rules were read; execution continues under the explicit autonomous
  user scope and repository TDD rules, without claiming a missing skill ran.
- PR #211 is a **proposed** distinct-UID/root-broker architecture, not an approved
  implementation. An independently reviewed Landlock + minimal bubblewrap
  profile may close the narrower same-UID credential-acquisition defect. It
  cannot establish ISO-01, full Task isolation or Windows-host containment.
- Production must not mount the host root. A test-only faithful synthetic
  provider view can retain #208's EACCES/EPERM controls; its mounts cannot be
  selected by an ordinary production request.
- No caller category selects a privileged execution route. Unsupported kernel,
  namespace, helper or policy setup fails before workload execution.
- Git configuration/hooks/transport and persistent supervision remain explicit
  review gates; a six-case security result alone cannot close M5.
- Private repository `1426564190` was created for the capability check. Actual
  protection API returns 403 requiring Pro or Public. No private task may be
  counted as accepted under the current external constraint.

## Validation ledger

- 2026-10-20: source/runtime investigation; original services remain active at
  db44c08, PIDs 2818/2962, NRestarts 0. Landlock ABI 7 and unprivileged mandatory
  user/mount/network namespaces measured on target WSL. These are capability
  observations, not sandbox acceptance.
- 2026-10-20: isolated Linux dependency install succeeded from frozen lockfile;
  genuine six-case baseline RED reproduced. No production code changed to make
  that baseline fail.
