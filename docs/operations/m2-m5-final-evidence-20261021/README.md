# M2 final integration readiness — 2026-10-21

This additive revision records the owner's scoped Public exception after the
[unchanged October 20 reports](../m2-m5-final-evidence-20261020/README.md).
Their `FORMAL_GATE_BLOCKED` result remains historical; no Private run is invented.

- [Acceptance decision and retained technical gates](acceptance-decision.md)
- [Deployment artifacts, compatibility and rollback boundaries](deployment-rollback.md)
- [Verified owner approval receipt](public-exception-approval.json)
- [Frozen component HEAD/base/check snapshot](stack-snapshot.json)
- [Nine actual non-main merge steps](integration-rehearsal.json)
- [Project main protection policy snapshot](main-policy-snapshot.json)
- [Measured native entry artifact](native-artifact-snapshot.json)

The rehearsal began at current main `ba9fc6814711e983a11e58a09ed04e8337a4effe`.
It used actual normal merges, because #135 diverges from current main; #221 is
the first listed component that already contains that main. All nine merges
completed without conflict. Result `064ea4133999cb1cd96a3c8ef7e7868b751f205c`
has tree `c490e71ef331ae42873a4323abcc18cf6267a752`, exactly equal to the old #225
HEAD `ab80b7cd5f549f73e463483467773a191ce1dd83`. No source was repaired or changed
by integration. The owned #225 branch was advanced without force to retain these
rehearsal commits, followed by this documentation-only revision.

Final exact HEAD, fresh commands, required CI and independent review outcomes are
bound in the [#225 publication record](https://github.com/jskjw157/gram-coding-agent/pull/225).
Those results must be inspected, rather than inferred from this initial rehearsal
receipt. The final candidate must preserve zero production/runtime/dependency/
build/security-policy differences from actual Task9 runtime `9d1a3f8…` before its
live evidence can be reused. No new Task or operational deployment is performed.

Merge route after separate approval:
`#135 → #196 → #213 → #214 → #216 → #221 → #222 → #223 → #225`.
Do not add #215, #217, #206, #208 or #211 again: their approved material is already
represented in the stack. Other parallel draft HEADs are excluded. Main, release
tags, production services, production migrations and issue closure remain untouched.
