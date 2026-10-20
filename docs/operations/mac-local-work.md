# Local file and Node execution

This optional development CLI provides real task-folder text reads/writes and
Node script execution on POSIX hosts, including Mac. It does not install or
change the health-only Core service, register a user session, start MCP, or
connect a tunnel. It creates no account, persistent key, database, or log file.

## Run in a disposable workspace

Use Node 24 and the repository's pinned pnpm version:

```sh
pnpm install --frozen-lockfile
pnpm --filter '@gram/local-work...' build
mkdir /tmp/my-reviewed-gram-task
node packages/local-work/dist/cli.js \
  --workspace /tmp/my-reviewed-gram-task --trusted-local-code < job.json
```

For example, `job.json` can contain:

```json
{
  "operations": [
    { "op": "write_text", "path": "answer.cjs", "content": "require('node:fs').writeFileSync('answer.txt', String(6 * 7));" },
    { "op": "run_node", "path": "answer.cjs", "args": [] },
    { "op": "read_text", "path": "answer.txt" }
  ]
}
```

The result contains `42`, command exit status, and in-memory run evidence.
File-only jobs do not require `--trusted-local-code`. A job containing execution
is refused before writing any files when that flag is absent. Unsupported
operation shapes are also rejected before any operation starts. Jobs are
sequential and not transactional: a later path error or process failure can
leave earlier authorized writes in the selected folder. A nonzero script exit
is recorded as FAILED and produces a nonzero CLI exit.

## Boundaries

Paths are relative to the selected task root. Absolute paths, parent escapes,
external symlinks, replacement of the selected root directory, and writes to
multiply linked or non-regular existing files are refused. Text is strict UTF-8
and limited to 1 MiB per operation. The JSON input is at most 1 MiB / 100
operations. Script execution accepts `.js`, `.mjs`, or `.cjs` files in the task
folder, with literal arguments, using the current Node binary without a shell.
It inherits a small, fresh environment, not the parent's credentials or Node
startup hooks. Known token patterns are redacted from stdout/stderr. File reads
return the requested text: the caller must not select secret-bearing files.

Execution defaults to a 5-second deadline and 64 KiB combined stdout/stderr.
Timeout, output overflow, and cancellation settle the call without waiting for
inherited pipes. SIGINT/SIGTERM in the CLI cancel the active process group;
ordinary descendants in that group are also terminated after script exit.
SIGKILL or a host crash cannot run cleanup. Deliberately detached descendants
can escape group cleanup; do not execute scripts that create them.

**`HOST_PROCESS_NOT_OS_SANDBOXED` is always reported.** The flag means the
caller has reviewed and trusts the code. It does not grant OS permissions or
create isolation. Scripts can access the invoking account's files and network
outside the selected folder. File checks assume no concurrent hostile directory
mutation and are not an OS containment mechanism. Do not expose this profile
to remote clients or the credential-owning Core. Untrusted code, arbitrary
executables, package-manager workflows, durable task recovery, MCP integration,
and GUI control require further implementation/review.

## Reuse and verification

The existing M2 candidate `173a3d0d3d1ddd983eb3d6de86ed2d27e19c82d9` supplies
the command parser, risk policy, worktree guard, `CommandRunner`, `FileService`,
and `WorkspacePathGuard`. The filesystem guard now takes a structural lookup
port rather than importing a SQLite repository. Its `linuxPath` field remains
the existing POSIX path contract. File writes additionally reject hard-link
aliases and non-regular files. M2 runner/policy tests are retained; the path
guard tests use an in-memory lookup with real temporary files.

```sh
pnpm exec vitest run --project local-work --project filesystem --project shell
node scripts/local-work-smoke.mjs
node scripts/local-work-cancel-smoke.mjs
```

The smoke scripts use only synthetic temporary workspaces and remove them.
The CI matrix repeats the workflow and cancellation checks on Ubuntu and Mac.
