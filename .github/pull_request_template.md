## Summary

- 

## Verification

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm build`

## Safety / architecture checks

- [ ] No secrets are committed or emitted in logs/results.
- [ ] No generic Windows command-execution API was added.
- [ ] MCP remains loopback-only and OpenAI `tunnel-client` remains the sole ChatGPT MCP tunnel.
- [ ] Repository mutation lock boundaries remain unchanged unless this PR explicitly changes and tests them.
