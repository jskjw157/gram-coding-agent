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

## Dependency awaiting user input

The database engine is not selected yet. The user was asked MSSQL / Oracle / PostgreSQL / MySQL. Implement the transport independently, but do not choose an engine, build four providers or claim live read-only enforcement without that answer. Driver/dependency choice, readonly transaction details and real integration fixtures must be added to this design once known.

## Verification

TDD for transport and driver behavior; real authenticated MCP tests; disabled-feature catalog preservation; engine-specific real restricted-account sentinel/cancel/bind tests; no secret leaks. Root lint/typecheck/unit/E2E/security/build and independent review on final candidate. No production config/service change or live business DB query is part of transport-only completion. Final acceptance needs an authorized target/read-only account; report any unavailable evidence explicitly.
