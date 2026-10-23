# ego(lite) read-only shopping snapshots through Gram MCP

Status: **opt-in implementation / review only**. Do not describe this as deployed
until the new tool appears in ChatGPT and a real ego(lite) observation succeeds.

## Design

- ego_public_shopping_snapshot({source}) is one typed MCP method. No arbitrary
  browser command, URL, JavaScript, selector, login, shell or Windows command is
  exposed to ChatGPT.
- Each source maps to one fixed public page on Naver+ Store, 29CM, Zigzag,
  Musinsa or ABLY. The service verifies the requested and final HTTPS hosts.
- The backend uses the documented ego-browser nodejs / snapshotText workflow,
  not Playwright or an unbounded CDP endpoint.
- GRAM_AGENT_EGO_BROWSER_MODE defaults to unset/off. Accepted values are
  disabled, windows (WSL2-to-Windows host bridge), native (ego installed
  alongside a native agent). Anything else is rejected at startup.
- Windows mode uses a generated fixed PowerShell -EncodedCommand wrapper to
  invoke installed ego-browser with a fixed stdin script. This is NOT a
  general Windows command API and no MCP caller controls executable or code.
- Time limit 75 seconds, stdout 96 KiB, snapshot 12000 characters. Stderr is
  drained but not returned. Existing Gram read sanitization is retained.
- Browser output is untrusted webpage content, not instructions. A single
  structured result marker is validated before returning any data.
- Sources marked discovery are homepages, not product-ranking feeds.
  Naver BEST click/keyword rankings are NOT proven sales volumes.
- Browser tabs may use the owner's session. Only the listed public paths are
  visited and no click/fill/login is performed. Prefer a dedicated ego Space.

## Source mapping

| source | Page | Signal type |
| --- | --- | --- |
| naver_best_viewed | https://snxbest.naver.com/product/best/click | Public viewed-product rank |
| naver_best_keywords | https://snxbest.naver.com/home | Public search keyword rank |
| 29cm_best | https://www.29cm.co.kr/store/best-items?category_large_code=268100100 | BEST item listing |
| zigzag_brand_ranking | https://zigzag.kr/brand/shop-list | Brand rank only |
| musinsa_home | https://www.musinsa.com/ | Discovery home, NOT ranking |
| ably_home | https://a-bly.com/ | Discovery home, NOT ranking |

These are fixed destination URLs, not a guarantee that sites show a complete
ranking in the ego session. Respect site terms, access controls and rate limits.
There is no login-gate, CAPTCHA or anti-bot bypass.

## Activation on Windows LG Gram with WSL2

1. Confirm ego(lite) Windows onboarding is complete. The Windows user must
   be able to run ego-browser nodejs locally. A macOS install on a different
   machine cannot be reached from this Windows WSL host.
2. Repair/verify the official OpenAI tunnel-client if disconnected. Never
   replace the tunnel or widen MCP listening beyond localhost.
3. Review and merge the PR only after passing CI and security review, then
   follow existing backup, guarded deployment and Issue 228 activation gates.
4. Opt in in **trusted service-side configuration only**:
   GRAM_AGENT_EGO_BROWSER_MODE=windows
   (native only if Gram and ego run on the same non-WSL host).
   Do not expose this setting as a public MCP argument.
5. Guardedly restart the agent, refresh ChatGPT connector tool schema,
   and confirm ego_public_shopping_snapshot appears.
6. Invoke the tool with a single JSON argument: {"source":"naver_best_viewed"}.
   Verify pageKind, requestedUrl, actualUrl, observedAt, evidence and bounded
   snapshot. No generated rank or sales estimates are allowed.
7. If permitted, test the second source, 29cm_best. Only then connect the
   existing 6-hour HAAR automation. This adapter does not implement a
   historical database, keyword SearchAd API, scheduler or Discord delivery.

## Failures and rollback

- Tunnel-client not seen: restore the existing tunnel before browser testing.
- ego-browser not found: check Windows user installation, PATH and WSL interop.
  Do NOT install a generic Windows shell tool as a workaround.
- Redirect or access restriction: return unavailable; do not bypass.
- Roll back by removing the opt-in variable or setting it to disabled,
  using the standard guarded service restart. Shopping orders, ads, site
  products and existing Task/RepoLocks are unaffected.

## Verification

Run pnpm lint, pnpm typecheck, pnpm test and security CI. New tests use fake
browser host responses and do NOT prove a real Windows ego runtime or tunnel.
A real on-device acceptance run remains mandatory.

Official docs:
- https://www.egolite.app/document/ko/docs/ego-browser
- https://www.egolite.app/document/ko/docs/windows/skills
- https://www.egolite.app/document/en/docs/custom-agent-harness
