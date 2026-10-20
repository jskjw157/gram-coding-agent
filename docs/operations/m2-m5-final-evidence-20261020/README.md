# M2 / command-boundary final evidence — 2026-10-20

**FORMAL_GATE_BLOCKED**: the Public live smoke and scoped credential boundary pass;
#77's Private repository requirement remains unmet. No waiver, main merge, release
or production deployment is implied.

Validated runtime/source: `9d1a3f81ac1d29a9bb716ffa798d06b19796fd16`.
This documentation branch preserves #217 unchanged and adds final evidence. Its
HEAD and CI are separate from the runtime SHA; it contains no production changes.

## Reports

- [Acceptance](M2-M5-Acceptance-20261020.md)
- [Actual Windows / WSL smoke](Windows-WSL-Smoke-Evidence-20261020.md)
- [Release readiness and remaining decisions](Release-Readiness-20261020.md)
- [Integration and rollback](Integration-Rollback-20261020.md)

## Portable receipts

- [Task9 acceptance and measured lock boundaries](m5-task9-final-acceptance-20261020.json)
- [Exact-source local gates](m5-final-integration-gates-9d1a3f8-20261020.json)
- [Exact-source GitHub CI](m5-ci-9d1a3f8-20261020.json)
- [Windows observer](m5-final-9d1a3f8-windows-observer-20261020.json)
- [Original runtime restoration](m5-final-runtime-restored-20261020.json)
- [Main ancestry and component PR heads](m5-final-integration-main-9d1a3f8-20261020.json)
- [Private branch-protection capability refusal](m5-private-gate-refresh-20261020.json)

Private SQLite backups, full task evidence, logs and restoration copies remain in
the preserved local recovery directory; these allowlisted summaries publish no
credentials, environments, lease tokens or raw database rows. They do not create
retrospective observations for TASK-000005.

The proposed merge route ends with this documentation PR after #223. It includes
#217's original commits and eight historical documents unchanged; do not duplicate
#217 as an additional integration step. #215 remains a validation preview, never
an additional merge alongside its component PRs. No actual main merge occurred.
