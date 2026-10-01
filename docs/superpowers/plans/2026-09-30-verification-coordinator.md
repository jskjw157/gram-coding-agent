# Verification coordinator implementation plan

1. Add strict production planner and tests for missing/blank commands, per-path class union, empty changes and conservative mixed UI refusal; retain legacy diagnostic API.
2. Add durable review identity/acceptance repository and migration. Test foreign binding, single-use, expiry, restart interruption and accepted-reference validation.
3. Add authenticated review MCP schemas and tools. Test missing/wrong auth and strict schemas.
4. Add bounded exact review source reader and dedicated metadata-only command capture. Test Git before/after identity, absence/deletion, sensitive paths, invalid bytes, bounds, timeouts and raw-source omission.
5. Add read-only review capability and coordinator. Test lease/workspace/task drift, unseen/different-attempt paths, replay/concurrency, snapshot drift, timeout/close and failed commands. Inject after MODIFY without weakening repair.
6. Wire main and real Git/SQLite/CommandRunner fixture integration, then independent boundary review. Run frozen install, full root tests, E2E, lint, typecheck, build and diff check. Commit clean results; parent owns remote publication.

All implementation uses TDD. Work remains on isolated feat/verification-coordinator-159 from f2a1435. User authorized autonomous internal review/test stages; parent approved this contract before implementation.
