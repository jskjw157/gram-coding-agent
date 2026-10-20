# Local file and code execution slice

This reversible development slice follows the existing architecture specification:
filesystem adapters own task-relative file access, policy classifies commands,
shell owns process execution, and a separate local application composes them.
The validated LAB_ONLY Core on PR #218 remains health-only.

## Reuse and entry point

Import the existing M2 `WorkspacePathGuard`, `FileService`, `CommandRunner`, and
their current policy dependencies from integration candidate
`173a3d0d3d1ddd983eb3d6de86ed2d27e19c82d9`. Replace the path guard's concrete
SQLite repository dependency with its minimal workspace lookup port. Keep its
legacy `linuxPath` field as the existing POSIX path contract. No schema change,
WSL invocation, GitHub publishing, tunnel, GUI, or user-session agent is needed.

Add an opt-in `@gram/local-work` JSON CLI with an explicitly selected workspace.
Read/write operations use task-relative paths. Execution accepts a Node script
inside that workspace, not an executable or shell command supplied by a client.
Execution requires `--trusted-local-code`; its default is refusal. Reuse M2 policy
and redaction, replace the unbounded process adapter with a POSIX adapter having
a deadline, combined output limit, and process-group cleanup. Keep evidence in
memory for this single invocation; do not create a service or credential.

## Trust boundary

This is a **trusted local development profile, not an OS sandbox**. A Node
script has the invoking account's filesystem/network privileges, including
outside the workspace. Environment filtering, path checks, deadlines, and
redaction do not isolate arbitrary code. Only reviewed synthetic scripts in
temporary workspaces may be executed during this task. Do not expose this
profile through MCP or install it in the credential-owning Core. Production
untrusted-code execution still needs an independently reviewed OS isolation
design. File path checks also assume no concurrent hostile directory changes.

## Verification and delivery

First add failing tests for file-to-code-to-result behavior, explicit execution
opt-in, path/symlink escape rejection, failure status, secret environment removal,
output redaction, deadline/output-limit enforcement, and descendant cleanup.
Run these against real temporary files and processes on Mac; retain existing M2
policy/runner regression tests. Then run repository checks, independent review,
and publish a separate stacked Draft PR based on PR #218. Confirm pushed SHA
and CI. No main merge, service installation, account, credential, TCC permission,
trust registration, tunnel, or GUI action is part of this slice.
