# M2 authenticated live GitHub smoke test

This procedure is the manual, authenticated smoke gate for M2. It runs one coding task against a **disposable private GitHub repository** and records evidence needed before the `v0.1.0` release gate.

This document does not replace the deterministic local E2E test tracked by #73. Run the live smoke only after the automated vertical-slice E2E passes on the exact release-candidate commit.

## Safety rules

- Use a disposable private repository created only for this smoke run.
- Never run this procedure against a production or personal working repository.
- Never commit, paste into issue comments, print, or echo GitHub tokens, MCP secrets, tunnel runtime keys, or secret-file contents.
- The long-running agent must use `FileSecretProvider`; GitHub credentials stay in the configured secret directory as regular files with mode `0600` or stricter.
- Do not put credentials in Git remote URLs.
- Do not weaken Policy Engine rules, Repo Lock behavior, or branch protection to make the smoke pass.
- A repository lock must not be released before the pushed SHA is confirmed remotely.
- PR creation and CI observation must occur without the repository mutation lock.

## Preconditions

All of the following must be true before starting:

1. #73 deterministic `task_create -> COMPLETED` E2E is GREEN.
2. Root gates are GREEN:

   ```bash
   pnpm lint
   pnpm typecheck
   pnpm test
   pnpm test:e2e
   pnpm build
   ```

3. The agent and OpenAI `tunnel-client` are configured according to [tunnel-setup.md](./tunnel-setup.md).
4. The runtime composition has real implementations for every step required by this smoke:
   - repository resolve/bind,
   - Repo Lock,
   - Git fetch/worktree,
   - repository instructions,
   - analyze/modify,
   - verification + evidence,
   - publishing,
   - PR create/reuse,
   - required-check observation.

   If any capability is intentionally fail-closed or unwired, **stop**. A fail-closed seam is not a smoke-test pass.

5. The agent is using the exact commit intended for release acceptance. Record it:

   ```bash
   git rev-parse HEAD
   ```

6. The disposable GitHub repository has:
   - visibility: private,
   - default branch: `main`,
   - a small deterministic project,
   - CI that runs for pull requests,
   - at least one required check used by the CI observer.

## Prepare the disposable private repository

Create a new private repository such as `gram-m2-smoke-<date>`. The repository must contain only throwaway test content.

A minimal target is sufficient:

```text
src/counter.ts
test/counter.test.js
package.json
tsconfig.json
.github/workflows/ci.yml
```

Seed an intentional bug, for example `increment(1)` returns `1` while the test requires `2`.

The CI workflow should run the repository's normal verification commands and expose a stable check name. Do not configure the smoke by making failing checks optional.

After pushing `main`, verify locally:

```bash
git status --short
git rev-parse HEAD
git rev-parse origin/main
```

Required:

- working tree is clean;
- local `HEAD` equals `origin/main`;
- the target test fails before the Gram task changes the code.

## Install the GitHub runtime credential

The default `GitHubClient` credential name is `github.token`.

Write the token directly to the configured Gram secret directory without printing it back to the terminal. The resulting file must be a regular file, not a symlink, and must have mode `0600` or stricter.

Example path shape:

```text
<GRAM_AGENT_SECRET_DIR>/github.token
```

Verify metadata only:

```bash
stat -c '%F %a %n' "$GRAM_AGENT_SECRET_DIR/github.token"
```

Do **not** run `cat`, `sed`, `env`, or any command that prints the token value.

The token should be scoped only to the disposable repository and only to the permissions needed by the M2 flow.

## Start the runtime

Start the agent before the tunnel:

```bash
sudo systemctl restart gram-coding-agent.service
curl -fsS http://127.0.0.1:3847/healthz
sudo systemctl restart openai-mcp-tunnel.service
```

Then verify service state:

```bash
systemctl --no-pager --full status gram-coding-agent.service
systemctl --no-pager --full status openai-mcp-tunnel.service
```

If either service is unhealthy, stop the smoke. Do not continue by bypassing MCP authentication or policy.

## Submit exactly one coding task

Submit a task through the normal authenticated MCP/ChatGPT path. The request should be narrow and deterministic, for example:

```text
Repository: <owner>/gram-m2-smoke-<date>
Goal: Fix increment() so the existing test passes. Change only the minimum required source file.
Publish mode: PULL_REQUEST
```

Record immediately:

- canonical Task UUID,
- human display sequence,
- repository GitHub ID,
- release candidate commit of `gram-coding-agent`,
- UTC submission time.

Do not create a second task for the repository during this smoke.

## Observe without intervening

Do not manually edit the task worktree, task branch, database, lock file, PR, or CI result.

The task must perform the normal path:

```text
task_create
-> repo resolve/bind
-> Repo Lock acquire
-> fetch
-> isolated worktree
-> instructions
-> analyze
-> modify
-> verification + evidence
-> commit
-> push
-> exact remote SHA confirmation
-> Repo Lock release
-> PR create/reuse
-> CI observe without lock
-> COMPLETED
```

Any manual repair invalidates the run. Start over with a fresh disposable repository.

## Required acceptance evidence

Collect evidence without secret values.

### Task identity and final state

Record:

- Task UUID;
- display sequence;
- final status;
- result summary, if present.

Final status must be `COMPLETED`.

### Workspace isolation

Record the persisted worktree path and verify:

- it is outside the canonical checkout;
- the canonical checkout remains unchanged;
- the intended source file changed in the task worktree;
- unrelated files were not published.

### Verification

Record:

- verification plan ID;
- HEAD SHA bound to the verification plan;
- every required check;
- PASS status;
- evidence reference or successful command-run ID for every required PASS.

A required PASS without persisted evidence is a failure.

### Commit and remote confirmation

From `git_commits`, record:

- full 40-character SHA;
- branch;
- `remote_confirmed = 1`;
- `remote_confirmed_at`.

Verify independently that the remote branch resolves to the same SHA.

### Lock release

From `audit_events`, record the `REPO_LOCK_RELEASED` event's `created_at`.

Also verify that no `repo_locks` row exists for the smoke repository before PR creation and throughout CI observation.

### Pull request

From `pull_requests`, record:

- PR number;
- URL;
- exact head branch;
- exact base branch;
- `created_at`.

The PR must target the disposable repository's default branch and must use the task branch that was remotely confirmed.

### CI observation

Record the **first local observation time** at which the CI observer calls the provider for required checks.

Do not substitute GitHub's provider-side `started_at` value for this timestamp.

The current `ci_runs.updated_at` field can be overwritten by later polling of the same provider check, so a completed database row by itself is not sufficient to prove the first observation time. #73/#77 acceptance instrumentation must preserve or externally record the first local observation timestamp.

Also record:

- provider run/check ID;
- workflow/check name;
- final status/conclusion;
- CI URL if present.

During every CI provider call, the smoke repository must have no active Repo Lock row.

## Core ordering invariant

The smoke fails unless the captured timestamps prove:

```text
remote_push_confirmed_at
  <= repo_lock_released_at
  <  pr_created_at
  <= ci_observed_at
```

And independently:

```text
repo_locks row absent before PR creation
repo_locks row absent during every CI observation
```

Do not infer this ordering from code structure alone. Use persisted timestamps plus the explicit first-observation evidence from the live run.

## Suggested read-only SQLite evidence queries

Use the runtime database in read-only fashion. Replace `<TASK_UUID>` and `<REPO_ID>` with values from the smoke task.

```sql
SELECT id, seq, repo_id, status, created_at, updated_at
FROM tasks
WHERE id = '<TASK_UUID>';

SELECT task_id, repo_id, linux_path, branch, head_sha, dirty, unpushed
FROM workspaces
WHERE task_id = '<TASK_UUID>';

SELECT id, task_id, head_sha, change_class, created_at
FROM verification_plans
WHERE task_id = '<TASK_UUID>'
ORDER BY id;

SELECT plan_id, name, required, status, command_run_id, evidence_ref,
       started_at, finished_at
FROM verification_checks
WHERE task_id = '<TASK_UUID>'
ORDER BY id;

SELECT sha, branch, remote_name, remote_confirmed, remote_confirmed_at, created_at
FROM git_commits
WHERE task_id = '<TASK_UUID>'
ORDER BY id;

SELECT event_type, created_at, payload_json
FROM audit_events
WHERE task_id = '<TASK_UUID>'
  AND event_type IN ('REMOTE_PUSH_CONFIRMED', 'REPO_LOCK_RELEASED')
ORDER BY id;

SELECT number, url, head_branch, base_branch, state, created_at, updated_at
FROM pull_requests
WHERE task_id = '<TASK_UUID>'
ORDER BY id;

SELECT provider_run_id, provider_check_id, workflow_name, check_name,
       status, conclusion, url, started_at, finished_at, updated_at
FROM ci_runs
WHERE task_id = '<TASK_UUID>'
ORDER BY id;

SELECT *
FROM repo_locks
WHERE repo_id = <REPO_ID>;
```

The final query must return zero rows after confirmed publishing and while CI is observed.

## Failure conditions

The live smoke is a failure if any of the following occurs:

- a fake or no-op capability is used for a required production boundary;
- the task needs manual modification or database repair;
- the worktree overlaps the canonical checkout;
- a required verification check lacks evidence;
- the pushed SHA cannot be confirmed exactly;
- the Repo Lock is released before remote confirmation;
- PR creation or CI observation occurs while the mutation lock is held;
- CI does not reach an acceptable required-check conclusion;
- the task is marked `COMPLETED` before required CI succeeds;
- a secret value appears in logs, MCP responses, Git, SQLite, PR text, or the acceptance record.

A fail-closed error is preferable to a false PASS. Record the failure seam and fix it before repeating the smoke.

## Acceptance record

After a successful run, copy only non-secret evidence into `docs/operations/m2-acceptance.md` for #77:

```text
gram agent commit:
task UUID:
display ID:
repository ID:
worktree:
task branch:
commit SHA:
remote_push_confirmed_at:
repo_lock_released_at:
PR number:
pr_created_at:
ci_observed_at:
CI conclusion:
final task state:
```

Confirm the ordering invariant explicitly and link the disposable PR.

Do not include tokens, request authorization headers, secret-file contents, or raw credential metadata.

## Cleanup

After the acceptance evidence is recorded:

1. stop using the disposable repository for any real work;
2. remove any local throwaway clone not needed for retained evidence;
3. revoke/delete the repository-scoped smoke credential if it was created only for this test;
4. delete the disposable private repository only after #77 evidence has been reviewed;
5. do not delete task recovery artifacts automatically if the smoke failed with dirty/unpushed/recovery state.

A failed smoke repository should be retained until the failure has been understood and the required recovery evidence has been collected.
