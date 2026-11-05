# Read-only MySQL / MariaDB queries

This optional capability adds `database_connections` and `database_select`. It is separate from the Agent's internal SQLite state and from isolated developer commands. It does not change filesystem/Git approval or network policy. The tested server profiles are direct MySQL8.4 and MariaDB10.11 endpoints.

## Connection and credential setup

Use an existing dedicated account with direct SELECT grants on the intended business database. USAGE and SHOW VIEW are also accepted. Roles, column-specific grant syntax, write/admin/FILE/EXECUTE privileges and GRANT OPTION are rejected by this initial profile. The Agent never creates users or changes database privileges. Each active query needs two sessions under that account, one for data and one for cancelling its own query; the runtime admits at most two queries.

Store the existing DB password through the service user's existing private FileSecretProvider directory under a `database-readonly-*` name. A password reference must never point to MCP, GitHub or tunnel credentials. Do not include passwords in JSON, shell command arguments, Git, ChatGPT messages or query logs. Existing Agent authentication files stay untouched.

Enable the capability only through a root-owned Linux JSON file whose canonical ancestors are root-owned and not group/other writable. The file must be regular, single-link, at most64KiB and not group/other writable. For example, a reviewed administrator can provision `/etc/gram-coding-agent/readonly-databases.json` with mode0444:

```json
{
  "version": 1,
  "connections": [
    {
      "id": "business",
      "engine": "mysql",
      "host": "db.example.internal",
      "port": 3306,
      "database": "business",
      "user": "gram_readonly",
      "passwordSecret": "database-readonly-business",
      "tls": {},
      "maxRows": 500,
      "timeoutMs": 10000,
      "maxBytes": 1048576
    }
  ]
}
```

Use `engine: mariadb` for MariaDB. TLS certificate and hostname verification are enabled by default. A private CA can be supplied as PEM contents in `tls.ca`; it is not an arbitrary file path. Only an explicit trusted-local `tls: false` permits plaintext, which exposes query/results on that network and should not be used as a certificate-error workaround. MCP arguments cannot change endpoints, credentials or TLS options.

A reviewed service configuration sets `GRAM_AGENT_DATABASE_CONFIG` to the installed file. An absent variable preserves the existing tool catalog and does not import/connect the database driver. An invalid configured file prevents startup. A valid configuration is loaded at startup but connections/credentials are acquired lazily on an authenticated query, so a business DB outage does not prevent ordinary Agent startup.

Activation requires the normal exact-build deployment procedure: preserve existing Task/worktree/Lock data, check that no work is active, verify backups/restores and startup, then normally transition Agent/Tunnel and validate the external MCP catalog. Do not point the service at a writable development checkout. This document is configuration guidance, not evidence that the user's business database has been connected or the candidate deployed.

## MCP calls

`database_connections({})` returns only IDs and engines. It never returns endpoints, login names, connection strings or secret references.

```json
{"connectionId":"business","sql":"SELECT id, name FROM customers WHERE id = ? LIMIT 20","parameters":[123]}
```

`database_select` uses server-prepared positional binds; values are not interpolated into SQL. Results contain parallel `columns` and row arrays, preserving duplicate column names. BIGINT/DECIMAL values retain precision as strings, date/time values are strings, and binary values use a `base64:` prefix. Known connection/Agent secrets are screened before text or binary disclosure. This filtering is not a claim to recognize every unknown business credential.

The supported SQL subset is a single SELECT, including supported SELECT-only CTEs, unions, subqueries and listed pure builtin functions. Unsupported functions/AST forms, comments/hints, cross-schema references, variables/assignment, locking and INTO variants are denied. SQL mode is pinned to `STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION,IGNORE_SPACE`; raw SQL is otherwise preserved. No SHOW/CALL/SET/DML/DDL API is exposed.

The adapter checks account grants, starts a READ ONLY transaction and streams results with trusted limits. Defaults are500rows/1MiB/10seconds; caps are5000rows/4MiB/30seconds,128columns and4MiB inbound packets. A row-limit preview returns `truncated:true` after stopping the query. Byte/column/packet overflow fails the operation rather than presenting an empty complete result.

Cancellation uses a separate pre-opened control session on the same backend/authenticated identity and kills only its owned query, then waits for a FIFO rollback barrier. A KILL acknowledgment alone is not proof of termination. Failed or unproven cleanup disables further DB queries and must be reported as failure. SQL text, parameters, rows, raw driver errors and credentials are not persisted in Agent logs/SQLite. The ordinary-command sandbox remains offline.

## Reproducible verification

Run `bash scripts/test-database-mysql.sh` with Docker, OpenSSL, Python3 and the pinned Node24/pnpm workspace dependencies. It creates only uniquely labelled disposable TLS-enabled MySQL/MariaDB containers bound to127.0.0.1, using private generated fixture credentials. The matching Vitest configuration requires both engines and refuses an empty suite. The CI `database-readonly-native` job runs the same script.

The private fixture directory retains passwords, TLS keys, seed SQL and Docker inspect output for local failure investigation. Never publish that directory. Only sanitized public metadata/test evidence can be shared. Fixture containers are retained for exact-ID review; do not use broad docker cleanup or touch unrelated containers.

The runtime depends on official `mariadb@3.5.4` and `node-sql-parser@5.4.0`; retain their LGPL-2.1-or-later and Apache-2.0 notices when distributing dependencies. They require no new Windows helper executable or application-control exception.
