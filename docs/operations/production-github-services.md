# Production pull requests and required checks

The agent composition uses `createProductionGitHubServices` to supply the
existing pull-request service and required-check client to the task runner.
PR metadata comes from persisted task/verification evidence. PR identities
and CI observations are persisted in the agent database. The runner retains
its existing confirmed-push-before-unlock and unlock-before-PR/CI ordering.

## Credentials and failures

The existing `github.token` secret is acquired only by the GitHub adapter,
per HTTP request, and the lease is disposed afterward. Construction/startup
requires no GitHub request or credential read. No credential is created,
permission granted, or account configured by this wiring.

The production transport uses `https://api.github.com`, refuses redirects,
and bounds each request to 30 seconds. Authentication, authorization, rate
limits, malformed responses, missing required-check configuration, and
transport failures stop the operation. There are no automatic HTTP retries
or inferred permission grants. HTTP error diagnostics retain the status code
without response bodies; transport errors omit potentially credential-bearing
messages and causes.

The already-configured credential must permit the relevant repository's PR
reads/writes, branch-protection required-check reads, and check-run reads.
The conservative unsupported-feature guards also require Metadata read for
active branch rules and Commit statuses read for status-presence detection.
A forbidden branch-protection read fails closed; it is never interpreted as
an absence of required checks. Supplying or expanding credentials remains an
operator action outside this code change.

## Deliberate limits

Only classic branch-protection required checks represented by the Checks API
are evaluated. Before every observation the production wrapper requires:

- An empty array from the active branch rules endpoint. Any applicable rule,
  including a rule unrelated to CI, blocks this slice rather than allowing
  mixed classic protection/rulesets to hide required checks.
- An empty array from the HEAD-bound commit statuses endpoint. Any legacy
  status, including successful or unrelated statuses, blocks this slice.
  Status outcomes and app identities are not evaluated. This prevents a
  passing check-run from hiding a same-name failing commit status.

Both guards reject malformed, unavailable, unauthorized, or rate-limited
responses. A nonempty first page is already enough to reject; an empty first
page establishes absence without pagination. No permission is requested or
expanded automatically. Missing existing-token read access is a setup blocker.
Rulesets, legacy-status evaluation, and merge-queue requirements remain
unsupported, with deliberate conservative over-blocking.

Endpoint references: [active branch rules](https://docs.github.com/en/rest/repos/rules#get-rules-for-a-branch),
[commit statuses](https://docs.github.com/en/rest/commits/statuses#list-commit-statuses-for-a-reference).

Local tests use fake HTTP/authentication ports and SQLite persistence. They
do not establish Windows/WSL live acceptance, live GitHub permission access,
or deployment readiness.
