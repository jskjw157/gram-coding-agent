# Gram Coding Agent Development Rules

- Read the architecture spec before architectural changes.
- Use TDD for behavior changes.
- Keep package boundaries from the spec; do not import application orchestration into adapters.
- Never add a generic Windows command-execution API.
- Never bind MCP to 0.0.0.0.
- OpenAI tunnel-client is the only MCP tunnel implementation.
- Never store secrets in SQLite, Git, logs, or MCP responses.
- Do not hold the repository mutation lock while creating PRs or observing CI.
- A remote push must be confirmed before releasing the repository lock.
