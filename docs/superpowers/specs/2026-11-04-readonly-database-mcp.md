# Read-only business database MCP capability

User request (2026-11-04): ChatGPT -> Gram -> read-only business DB -> SELECT results; implement in parallel, preserve existing features.

## Scope and architecture

Add an optional, trusted named-connection capability alongside existing MCP file/Git/Task tools. Internal SQLite persistence and migrations are unchanged. This is an explicit user-requested extension of the MCP surface, not a migration to remote persistence. Do not alter CommandRunner, M5 network isolation, filesystem authority, approvals or global redaction behavior.

MCP is an adapter only. A new optional ReadOnlyDatabaseToolsPort is supplied by Agent composition; without it, existing catalogs and behavior stay unchanged. The selected DB's dedicated adapter owns credentials, SQL validation, actual read-only enforcement, result bounds, cancellation and connection cleanup. No generic command API or caller-selected endpoint/credential/driver is added.

## Fixed transport contract

- database_connections({}) -> array of {connectionId, engine}. Configured IDs/types only; omit hosts, database names, logins, secret references and connection strings.
- database_select({connectionId, sql, parameters?}) -> {columns: string[], rows: (string|number|boolean|null)[][], truncated: boolean}.
- parameters is a positional array of JSON scalar bind values; the selected engine adapter documents its native placeholder syntax. No SQL interpolation.
- connectionId: 1-64 ASCII letters/digits/underscore/dot/hyphen, starting alphanumeric. sql: nonempty, at most 16,384 UTF-8 bytes. Up to 100 parameters; string bind values at most 8,192 UTF-8 bytes; numbers must be finite.
- Result limits are trusted configuration, not caller-overridable. Bound rows/columns/serialized bytes before accumulation; preserve duplicate column names with row arrays. Engine-specific type conversion must preserve precision.
- Tool schema rejects unknown fields. Errors are fixed/sanitized and must not expose SQL, parameters, raw driver errors or credentials. Existing MCP authentication precedes tool dispatch.
- The internal select(input, signal: AbortSignal) port receives the SDK request context signal; callers cannot supply or override it in MCP arguments. A pre-aborted request must not invoke the port.

## Credential and execution boundaries

Only trusted local configuration selects known endpoints, TLS, existing read-only credentials and execution limits. Use SecretProvider leases at connect time and dispose them. Do not store SQL, parameters, DSNs or result rows in Agent SQLite/logs. New DB credential screening is local to this capability plus existing MCP screening, not a new global policy for file/Git tools.

Actual engine read-only transactions/sessions and restricted account authority are mandatory where supported. A SELECT prefix, AST or routing intent alone is not sufficient. Validate the supported single statement/dialect, including nested CTEs; fail closed for unsupported executable/writing constructs. Do not provision or enlarge DB privileges automatically. New capability does not expose the Agent's internal SQLite databases.

Timeout, overflow and cancellation close/drain/destroy actual driver work, without hidden continued execution or reused session state. Use lazy connections so an unavailable business DB cannot prevent ordinary Agent startup.

## Selected MySQL / MariaDB implementation

The user selected MySQL / MariaDB. Use the official pure-JavaScript MariaDB Connector/Node.js 3.5.4 (Node24 supported) with node-sql-parser 5.4.0 for a bounded MySQL SELECT AST guard. No other database providers are added. Keep existing workspace dependency versions; retain the driver's LGPL-2.1-or-later license notices when distributing it.

The adapter supports direct MySQL8.4 and MariaDB10.11 endpoints. Each request uses dedicated data/control sessions with matching backend UID and authenticated identity; no pool or session-state reuse. Only direct USAGE/SELECT/SHOW VIEW grants are accepted; accounts with roles, write/admin/FILE/EXECUTE privileges or GRANT OPTION are rejected. Start a READ ONLY transaction, use real prepared positional `?` binds and stream rows as arrays. Set SQL mode STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION,IGNORE_SPACE to agree with the parser; configure the engine's server-side SELECT execution deadline.

Supported SQL is one SELECT with supported SELECT-only CTEs, unions and subqueries. Unknown AST/function forms, comments/hints, qualified function calls, cross-schema references, assignment, locking and INTO variants are denied. Exact SQL is preserved; no derived-table wrapper changes duplicate column names. BIGINT and DECIMAL precision is retained as strings, date/time fields as strings, and binary values as base64-prefixed strings after credential screening of original bytes/text. Known connection/Agent secrets in text or binary are withheld before encoding; this is scoped to DB results and does not alter file/Git policies.

Only a protected Linux JSON configuration enables the optional capability. It contains named endpoints, account names and database-readonly-* credential references, never passwords. TLS certificate and hostname verification is on by default; only trusted local configuration can explicitly select plaintext or a bounded PEM CA. Remote MCP cannot supply these settings. Query defaults: 500 rows, 1 MiB JSON, 10 seconds; hard caps: 5,000 rows, 4 MiB JSON, 30 seconds, 128 columns, 4 MiB input packets and two active requests. Exceeding the row bound produces a truncated preview after stopping the query; byte/column/packet overflow fails the query.

Cancellation uses the existing control session to KILL only its owned data query, then waits for a queued rollback barrier on the data session. A KILL acknowledgment alone is not completion. An inability to prove cleanup must disable new DB queries and fail close, never report normal verified shutdown. No business DB schema, privileges or Agent SQLite rows are changed. Dedicated temporary TLS fixtures verify both engines; the actual user's endpoint/read-only account is still required for production acceptance.

Primary references: [connector APIs](https://mariadb.com/docs/connectors/mariadb-connector-nodejs/connector-nodejs-promise-api), [connector limits](https://mariadb.com/docs/connectors/mariadb-connector-nodejs/node-js-connection-options), [MySQL read-only transactions](https://dev.mysql.com/doc/refman/8.4/en/commit.html), [MariaDB transactions](https://mariadb.com/docs/server/reference/sql-statements/transactions/start-transaction), [MySQL KILL completion](https://dev.mysql.com/doc/refman/8.4/en/kill.html).

## Verification

TDD for transport and driver behavior; real authenticated MCP tests; disabled-feature catalog preservation; engine-specific real restricted-account sentinel/cancel/bind tests; no secret leaks. Root lint/typecheck/unit/E2E/security/build and independent review on final candidate. No production config/service change or live business DB query is part of transport-only completion. Final acceptance needs an authorized target/read-only account; report any unavailable evidence explicitly.
