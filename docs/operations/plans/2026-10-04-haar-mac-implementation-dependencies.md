# HAAR Mac 연동 구현 작업 분해와 의존성

작성: 2026-10-04 (Asia/Seoul)

**상태: 구현 계획 제안 / 실행 전 검토 필요.** 아래 architecture decisions와 검증 계약은 USER APPROVED지만, 이 문서는 구현 완료나 설치·계정 생성·live 연결·병합 승인이 아니다. 이번 작성에서는 production code와 다른 lane을 변경하지 않는다.

**Git 전달 상태:** 이 계획과 승인 decision ledger는 docs 전용 브랜치 `docs/haar-mac-approved-decisions-plan`에 commit/push하여 원격에 보존한다. 이는 문서 전달을 위한 Git mutation이며 production code, MAC-02 lane, issue 상태, 설치·계정·live 환경을 변경했다는 뜻이 아니다. 이 문서를 PR로 제안하더라도 자동 merge나 production acceptance를 의미하지 않는다.

## 1. Source of truth와 범위

- 승인된 결정과 검증 계약: `docs/operations/decisions/2026-10-04-haar-live-provider-and-auth-decisions.md`, D1–D13. 후기 결정 D11/D12/D13이 앞선 설명을 구체화하거나 대체한다.
- 기존 package 경계: `AGENTS.md`, `docs/superpowers/specs/2026-09-15-gram-coding-agent-design.md`.
- 기존 Mac 방향: docs ref `31e66aa21b705b1793f11122c1b12d5ebf41715c`의 macOS operations/lifecycle specs, MAC-03/MAC-04/MAC-05 specs/plans와 delivery index.
- 위 기존 DRAFT 문서 전체를 APPROVED로 변경하지 않는다. 기존 task 번호·타입·수치는 구현 시 최신 코드와 대조한다. 승인되지 않은 수치나 native readiness를 사실로 취급하지 않는다.
- 목표: 하나의 repo와 공통 task/control 계층에서 상주 HAAR Operations와 주문형 Coding을 지원하고, 실제 GPT → target Mac → Shopify 경로를 검증한다.
- Shopify는 첫 공식 live commerce provider다. Provider Registry abstraction을 유지한다. 공식 API/connector 우선, 지원되지 않는 UI 작업만 관리된 browser fallback을 사용한다.
- Operations/Coding은 별도 macOS account/runtime으로 격리한다. 같은 uid의 두 프로세스나 환경변수 분리를 production 격리로 인정하지 않는다.
- 원문 credential은 credential-owning broker/transport worker 안에서만 사용한다. ShopifyAdapter/Core/MCP/Coding으로 password/token/cookie를 반환하는 경로를 만들지 않는다.

**변경 금지 완료 원칙:** CI GREEN은 필요조건이지 충분조건이 아니다. SKIP/NOT_RUN/UNKNOWN은 PASS가 아니다. Ambiguous effect는 reconcile 전 자동 재전송하지 않는다. Live READ_ONLY, limited WRITE와 high-risk action은 서로 다른 승인 경계다.

## 2. 현재 MAC-02 및 M2 상태

GitHub 조회 스냅샷: 2026-10-04 02:05–02:06 UTC. 아래 SHA는 계획 근거이며 미래 작업의 base를 고정하는 지시가 아니다. 각 CLAIM 직전에 원격 head·최신 댓글·소유권을 다시 확인한다.

| 항목 | 확인한 head | 현재 상태 | 구현 계획에 미치는 영향 |
| --- | --- | --- | --- |
| main | `fdf5dda2211e011e473f1c89095b78d7cb565c2f` | 기본 bootstrap | 완성된 Mac/Operations가 아님 |
| PR #138 / `feat/macos-service-lifecycle` | `3d0187c00bf0088f0818a8d45000c903f904d405` | Draft OPEN, verify/macOS/Ubuntu CI SUCCESS, NOT DEPLOYABLE checkpoint | Mac 주요 integration branch. 자동 병합·배포 금지 |
| PR #144 / `feat/mac02-install-transactions` | `463ca943331846013c78b7fa80aacc11ab433b4d` | Draft OPEN, REVIEW BLOCKED; 기록된 verify FAILURE, lifecycle checks SUCCESS | B-lane repair와 최신 A integration을 함께 검증해야 함 |
| PR #165 / `fix/mac02-local-control` | `7f9aadc6a3a32a14777d096444d273de68f6fdda` | Draft OPEN, verify/macOS/Ubuntu CI SUCCESS; base는 #144 head | B3 납품 존재, 아직 #144/#138 통합 전. 추가 인수 검증 필요 |
| PR #160 | `a66a80ace55edd6df980a16bfba4c36a4e0daf8b` | #138로 MERGED | diagnostic CLI 재구현 금지 |
| #146 / #147 / #149 | 납품 repair PR 확인되지 않음 | 각각 B1/B2/B4 OPEN | 독립 lane에서 최신 CLAIM 확인 후 구현·검증 필요 |
| #141 | 납품 PR 확인되지 않음 | C packager OPEN, 조회 시 CLAIM 없음 | 릴리스 packager 선행 작업 |
| #143 | #138 integration head 기준 | A RESERVED, runtime/tunnel/composition 담당 | shared/native 최종 연결은 A 소유권 유지 |
| #139 / #140 | issue 계약 | 병렬 governance / installer parent OPEN | 파일 소유권·통합 순서의 기준 |
| PR #135 / M2 | `efa4accfdc284754da53c807797e287a38180c59` | Draft OPEN, CI SUCCESS | Windows/WSL 및 Coding 기반 보존. Mac branch에 자동 포함됐다고 보지 않음 |
| #151 | CLOSED | command approval persistence/MCP 구현 완료 | 실제 Mac 공통 base 포함 여부와 Operations 연결은 별도로 검증 |
| #153 / PR #164 | `1f5f19df399eee4114828861ebf098410c97d496` | OPEN, CI SUCCESS, base는 M2 | shell redirection 보안 lane 유지. 중복 구현 금지 |
| PR #145 | `f22f3ab4393dfc81651aa28c5341b844b6db74b4` | 원본 #144에 대한 test-only RED reference | 관련 case만 읽고 사용. 전체 RED branch를 merge하지 않음 |

PR #144의 base snapshot `6d76d6fc1ec3cc9dae32880676c1cac724c28150`과 현재 A head는 다르다. 확인한 compare에서는 A가 68 commits 진행했다. 이것은 다른 lane을 rebase하라는 뜻이 아니다. Integrator가 최신 조합의 호환성과 실제 merge 결과를 별도로 검증한다.

기록된 #144 verify run `36573946967`의 실패 로그는 historical synthetic merge `11751dde8ff9df0c04d1f9e5b0607b5d6e20033d`에서 runtime-stores/service-session/supervisor-entry 관련 lint 11건이다. 현재 `3d0187c`에 같은 오류가 남았다고 단정하지 않는다. 최신 통합 조합에서 root 검증을 다시 실행한다.

### B3 완료 판단 보정

이전 대화의 “#148 완료”는 납품·일부 regression·CI 상태를 전체 acceptance와 혼동한 표현이었다. 정확한 상태는 **Draft 납품 + CI GREEN + 미통합 + 남은 검증/수정 가능성**이다.

`7f9aadc` 소스를 이번 계획 작성에서 다시 읽어 다음을 확인했다. 아래는 source review finding이며, 이번 턴에 새 RED를 실행한 결과는 아니다.

- `local-control.ts:70` 등은 service result를 그대로 반환한다. Unexpected extra fields/raw provider detail의 경계 차단을 테스트해야 한다.
- `local-control.ts:85`의 보상정리는 Core만 다루며, 시작된 tunnel과 실제 ownership 증거를 충분히 검증하지 않는다. 예외 경로 `local-control.ts:116` 등은 이 보상 경로를 건너뛴다.
- `local-control.ts:138`의 digest-null stop 성공과 `local-control.ts:186`의 uninstall 선행 stop은 foreign/residual identity에서 mutation0 조건과 대조해야 한다.
- `local-control.ts:180`의 reset 응답은 strict `true` 판정이 아니다.
- `test-support/installer-control/local-control-fixture.ts:55`의 capability는 execution-record reset의 alias다. 실제 stopped-failure 이력/상태 reset 및 HELD/revision/DB 보존을 입증하지 않는다.
- 원래 #148의 top-level `LocalControlPorts.resetStoppedFailure` 제안과 #165의 restore-port capability 위치가 다르다. A/#139가 typed contract 위치를 명시적으로 확정하고 함께 검증해야 한다. Shared 계약을 각 lane이 임의 수정하지 않는다.

경로 접두사는 `packages/macos-lifecycle/src/`이다. B3 파일은 이 계획에서 수정하지 않으며 소유 lane의 scoped RED→GREEN 작업으로 처리한다.

### MAC-02 파일 ownership 및 PR target

Issue body 재확인: 2026-10-04 02:16 UTC. 아래는 기존 lane 계약을 요약한 것이며 새 소유권 배정이 아니다.

| Lane | 독점 수정 경계 | PR target / 중요한 읽기 전용 경계 |
| --- | --- | --- |
| B1 #146 | `install-service.ts`의 apply/private helpers, apply describe, 전용 apply regressions/fixture/note | `feat/mac02-install-transactions`; 같은 파일의 legacy rollback 함수/describe, shared fixture/contract/adapter는 수정 금지 |
| B2 #147 | 신규 `rollback-service.ts`/test, `installation-transaction/rollback-contracts.ts`, 전용 rollback regressions/fixture/note | `feat/mac02-install-transactions`; `install-service.ts`/기존 rollback export는 읽기 전용, A가 연결 |
| B3 #148 | `local-control.ts`/test, control-contracts, 전용 control regressions/fixture/note | `feat/mac02-install-transactions`; shared contracts/runtime/launchctl/installer fixture는 읽기 전용 |
| B4 #149 | install-files/closed-schema/journal/schema-guard/provisioning 및 관련 tests, 기존 `test-support/installer/fixture.ts`, 전용 data regressions/fixture/note | `feat/mac02-install-transactions`; config/reader/공유 schema에 키를 추가하거나 apply/control/rollback를 수정하지 않음 |
| C #141 | `platform/macos/package-release.mjs`, `platform/macos/packaging/**`, 전용 packaging tests/fixture/note | `feat/macos-service-lifecycle`; installer/runtime/CLI/새 manifest consumer와 shared exports/package/lockfile은 읽기 전용 |
| A #143 | authority/runtime/owned-process/stopped recovery/native bootstrap, helper source, shared exports/package/workflow 및 composition | 기존 #138 유지; B/C/D 전용 구현을 재작성하지 않음 |

B1/B2/B4 issue의 historical code pin은 `e3c6589`, C는 `3f5a350`이다. 실제 시작 base는 최신 target `463ca94`/A head와 diff 및 CLAIM을 확인한 후 owner/#139가 확정한다. 이미 고친 사항을 되돌리는 오래된 base 사용은 금지한다. 각 issue의 최신 body가 이 요약보다 상세한 경계의 source of truth다.

## 3. 우선순위와 병렬 실행 규칙

- **P0:** deployability/security/durable-effect의 선행 조건. 먼저 해결하되 파일이 겹치지 않는 작업은 병렬 가능.
- **P1:** fixture에서 실제 task/workflow/provider 실행면 완성.
- **P2:** target Mac native, Shopify test-store, 실제 GPT tunnel E2E와 live READ_ONLY 인수. 최종 완료에 필요하지만 외부 승인/환경이 준비돼야 실행 가능.
- **P3:** 별도 승인된 live limited WRITE 및 high-risk action별 활성화. 일반 production acceptance와 별도다.

각 WP는 책임·납품 단위이며 한 번의 거대 PR 단위가 아니다. 구현자는 WP 안에서도 contract/test/adapter/owner-wiring 단위로 작은 task와 PR을 나눈다. 미검증 수치, API 기능, 계정 UID나 signing identity를 추측해 채우지 않는다.

**Shared single-writer:** common exports, package registration, migrations, lockfile, Task Engine 공통 계약, MCP router, composition roots와 runtime wiring은 지정 integrator가 직렬 반영한다. 전용 adapter/fixture 구현과 shared 연결 PR을 분리한다.

**단일 task/control/DB authority:** 공통 control 계층이 durable task/approval/effect 상태를 소유한다. Coding worker는 scoped typed IPC로 요청·결과를 교환한다. Operations SQLite/profile/registry를 직접 수정하거나 credential capability를 갖지 않는다. 한 SQLite 파일을 두 account가 직접 writable로 공유하는 방식은 금지한다. 별도 worker가 두 번째 공통 scheduler/Task Engine을 만들지 않는다.

## 4. 7단계 구현 작업 분해

각 checkbox는 구현 완료 체크용이며 현재 모두 미완료다. 현재 존재하지 않는 아래 경로는 **proposed new paths**다. 역사적 main의 부재를 최신 integration의 부재로 단정하지 않고 WP-07에서 다시 inventory한다.

### Phase 0 — MAC-02 repair, runtime wiring, reviewed base 확보

**먼저 끝낼 사항:** B1/B2/B4/C와 B3 잔여 acceptance, 이후 A의 연결 및 실제 최신 조합 검증. D CLI는 이미 통합되어 재개발하지 않는다.

- [ ] **WP-01 / P0 — B4 데이터 계약 (#149).** Manifest/journal의 reader-writer round-trip, UID/GID/closed schema 및 실제 registry digest를 issue 그대로 검증한다. 위 B4 독점 경로와 원래 shared installer fixture를 담당한다. 기존 schema/fixture exports를 임의 개편하지 않고 실제 presence/override를 정직하게 반영한다. RED: corrupt/foreign/mismatch input. GREEN: 실제 reader와 bytes/digest가 일치한다. 정직한 fixture가 sibling failure를 드러내면 숨기지 않고 해당 owner에 전달한다. Dependencies: 최신 CLAIM/base 확인. Owner: B4.
- [ ] **WP-02 / P0 — B1 apply transaction (#146).** 기존 `install-service.ts`의 apply/private helpers와 전용 apply fixture만 수정한다. Publish/journal의 각 interruption, 완료 상태, failure compensation, stopped delivery를 검증한다. Dependencies: reviewed 기존 계약; B4 납품을 기다리지 않고 전용 byte fixture로 병렬 구현 가능. 실제 writer-reader 통합 검증은 WP-06에서 B4와 함께 한다. Owner: B1.
- [ ] **WP-03 / P0 — B2 rollback target (#147).** 전용 `rollback-service.ts`, `installation-transaction/rollback-contracts.ts`, rollback tests/fixture. Issue의 `rollbackToReviewedTarget(targetReleaseDigest, ports)`와 자체 target/closure ports를 납품한다. Target digest는 `release.json` 실제 bytes digest다. 실제 검증된 target release를 해석하고 services 확정 중지 및 `confirmDatabaseClosed === true` 뒤 schema를 확인한 후 target bytes 복원·검증한다. 불명확 closure/target은 non-success. 기존 `install-service.ts`를 또 수정하지 않는다. Dependencies: reviewed 기존 계약; B1/B4와 독립 구현, 최종 export 연결은 A. Owner: B2.
- [ ] **WP-04 / P0 — B3 잔여 안전성 (#148 / #165).** 위 source findings를 scoped RED로 재현하고 issue 전체 acceptance를 채운다. Remove false/null/throw, replaced/foreign bytes 보존, pre-start identity/config/journal, restart ownership/예외 보상, 실제 stopped-failure fixture, response sanitization과 authorize/lock/release/restore/reset 예외를 검증한다. Dependencies: 최신 #148 CLAIM/#165 head; native reset binding은 WP-06. Owner: 기존 B3. CI GREEN만으로 종료하지 않는다.
- [ ] **WP-05 / P0 — C release packager (#141).** `packageRelease(options)`와 direct entry를 납품하되 import 시 build/install/spawn을 하지 않는다. 재현 가능한 release와 `release.json` exact-bytes digest, 실제 helper/entrypoint hashes 및 compatibility manifest를 생성·검증한다. `coreTools=['agent_health']` 등 고정 release schema를 유지한다. 필수 `supervisor-cli.js`/helper가 없으면 stub 대신 fail한다. 전용 packager lane만 수정하며 서명 키·credential/DB/cache를 release/Git/log에 포함하지 않는다. Tamper/incomplete/foreign bundle을 거부하는 RED, 생성 bundle을 runtime reader가 소비하는 surface QA를 수행한다. Dependencies: issue의 release contract; B repairs와 병렬. Owner: C.
- [ ] **WP-06 / P0 — A wiring + installer/lifecycle 통합 검증 (#143/#139/#140).** B1/B2/B3/B4/C와 이미 통합된 #160을 실제 native ports에 연결한다. Runtime UID·owned stopped proof·LifecycleStore failure reset, bootstrap provenance, Core/tunnel custody, closed-schema proof와 안전한 CLI dispatch를 검증한다. Dependencies: WP-01…05 reviewed delivery; 독립 bootstrap 작업은 그 전에도 A가 수행 가능. Integrator가 승인된 branch 조합에서 #144 → #138 compatibility 검증과 root/host CI를 실행한다. 다른 lane을 임의 merge/rebase하지 않는다. LAB_ONLY health-only 계약은 유지하며 Operations/Coding 도구를 여기에 몰래 추가하지 않는다. 관리자 설치/계정/reboot는 별도 승인 후 native 단계에서 수행한다.

**Phase exit:** reviewed exact integrated candidate SHA와 release digest, root 검증 및 Mac CI 증거 확보. 이것만으로 target Mac 설치/production acceptance가 완료된 것은 아니다.

### Phase 1 — 공통 baseline, canonical contract, policy와 durable ledger

- [ ] **WP-07 / P0 — Reviewed common base + contract/ownership inventory.** `domain`, `policy`, `persistence`, `mcp`, `apps/agent`, M2 Task Engine/runner/workspaces/Git 경계를 실제 최신 코드에서 확인한다. #135/#151/#153/#164 변경을 각각 소유자가 검토한 상태로 공통 base에 연결할 통합 계약을 작성한다. #151 CLOSED가 Mac branch 포함 증거를 대신하지 않는다. 이 단계에서 owner-approved common 계약을 고정하면 MAC-03 fixture 작업은 MAC-02와 병렬로 가능하다. Native 실행에는 WP-06 완료도 필요하다. Next-free migration 번호, 단일 DB owner, Operations/Coding 배포 profile 및 고정 IPC/service identity를 확정하고 historical DRAFT의 파일명/계정/수치를 자동 승격하지 않는다. Coding regression baseline과 owner wiring 경계를 기록한다.
- [ ] **WP-08 / P0 — Canonical Operations contracts + Provider Registry 계약.** `packages/domain/src/operations.ts` 및 MAC-04 `packages/automation-contracts/**`의 additive 타입. Task status/effect state/auth state를 구분한다. Intent, scope, account/store/target, parameter digest, expected state, provider/recipe binding, receipt와 authority envelope를 strict schema로 고정한다. Adapter가 trusted risk level을 제출하는 구조는 금지한다. Dependencies: WP-07 contract freeze. RED: unknown keys/identity drift/hash field 누락. Surface QA: 실제 parser/hash driver로 각 변경의 hash/validation 결과 확인.
- [ ] **WP-09 / P0 — 중앙 action policy + Operations approval.** `packages/policy/src/operation-policy.ts`, #151 repository/control surface의 최소 additive 연결. Canonical action matrix는 product/catalog/inventory/order/fulfillment/customer/payment/settlement 및 계정/설정/삭제 action을 포괄하되 API 지원/권한/정책이 확인된 것만 활성화한다. READ scoped 자동, REMOTE_WRITE action별 allowlist/한도, HIGH_RISK exact approval, DENY는 policy change 전 해제 불가. Approval hash에 승인된 모든 identity 필드를 포함하고 single-use/expiry/cross-task replay 방지. Human approval actor/authorization을 검증하여 GPT가 자기 요청을 스스로 승인하는 경로를 허용하지 않는다. Dependencies: WP-08, WP-07에서 확인한 #151 계약. RED: D13의 모든 approval 변조·재사용 및 한도 초과. Surface QA: pending→approve/deny→consume-once를 실제 policy/repository driver로 실행.
- [ ] **WP-10 / P0 — Operations persistence + migration.** `packages/persistence/src/migrations/<next-free>_operations*.sql`, operation/effect/lease/block/approval/audit/artifact/schedule repositories. 기존 migration을 수정하지 않고 Coding rows/FK/sequence를 보존한다. 하나의 DB owner가 task/operation creation과 dispatch prerequisites를 transaction으로 저장한다. Audit는 canonical metadata/digest/sanitized receipt만 저장하고 raw provider body/credential/고객 PII를 넣지 않는다. 재개 입력은 허용된 canonical data 또는 scoped artifact ref+digest로 보존한다. Dependencies: WP-08; 승인 repository binding은 WP-09와 single-writer가 조정. RED: crash/transaction conflict/schema mismatch/downgrade. Surface QA: 실제 SQLite upgrade/reopen와 기존 데이터 보존 확인.
- [ ] **WP-11 / P0 — Lease/fence + effect coordinator/reconciliation.** `packages/task-engine/src/operations/**`의 resource leases, durable blocks, effect coordinator. Multi-resource acquire는 all-or-nothing, stale worker/fence는 dispatch 금지. PREPARED/DISPATCHING은 외부 effect 전에 durable commit하며 crash 후 ambiguous dispatch는 UNKNOWN으로 reconcile한다. Local idempotency key만으로 retry 금지. NOT_APPLIED 확정 후 policy/approval/state를 다시 확인해야 재시도 검토 가능하다. Dependencies: WP-09 + WP-10. Approval consumption과 dispatch reservation의 crash window를 검증하고 실패가 승인 재사용이나 이중 effect로 이어지지 않게 한다. Surface QA: process kill/restart + SQLite/provider fixture effect-count 비교.

### Phase 2 — 단일 workflow/control 실행면과 복구 증명

- [ ] **WP-12 / P1 — Workflow runner/checkpoint/schedule/artifact + MCP composition.** `task-engine/src/operations/**`, `packages/artifacts/**`, `packages/mcp/src/tools/operation-tools.ts`, `apps/agent/src/operations-composition.ts`. 기존 Task Engine 기반으로 fixture recipe/task 생성→실행→receipt→resume를 완성한다. 상주 schedule도 동일 engine을 사용하며 중복 실행 방지는 WP-11을 소비한다. Coding용 가짜 repository/PR을 Operations에 만들지 않는다. API 입력/metadata는 scope 제한·sanitization을 거친다. Dependencies: WP-09…11. RED: cross-requester/schedule duplicate/checkpoint drift/artifact escape. Surface QA: 로컬 MCP fixture task 수행은 supporting evidence로만 기록한다. LAB_ONLY에는 새 tool을 노출하지 않는다.
- [ ] **WP-13 / P0 — Fault harness + Coding dependency fixture.** D13의 8 crash 지점, auth refresh/session expiry/WAITING_USER/approval issued/worker crash/core restart/tunnel drop을 독립 case로 구현한다. Worker는 `OK / DEPENDENCY_FAILED / CANCELLED / TIMEOUT / UNAVAILABLE` 등의 allowlisted 결과만 반환한다. 실패한 필수 Coding dependency는 WAITING_DEPENDENCY 또는 safe failure로 전환한다. Dependencies: WP-11 + WP-12. Gate A에서는 synthetic transport/worker로만 입증하며 실제 OS 격리/restart 성공을 주장하지 않는다. Surface QA: 별도 fixture process를 중단·재개하고 provider counter/ledger/audit를 비교한다. UNKNOWN 효과를 age/TTL만으로 실패 처리하거나 삭제하지 않는다.

### Phase 3 — OS-enforced domains, credentials/auth, Shopify 실행면

- [ ] **WP-14 / P0 — Signed native channel + domain runtime packaging/IPC.** MAC-04의 `platform/macos/operations-helper/**`, `automation/native-channel*`, composition owner wiring. 별도 non-admin Operations/Coding account와 ACL, authenticated IPC peer UID/signing/release/session identity를 사용한다. Node binary 서명만으로 임의 JS child를 신뢰하지 않는다. 고정 entry/release provenance와 allowlisted request만 허용한다. Single task/control owner는 worker를 typed request로 호출하며 양쪽 arbitrary shell injection, Coding의 credentialRef/broker/profile 접근을 거부한다. Dependencies: WP-07…09, fixture IPC는 WP-13 계약 소비; native 실행은 WP-06 + 별도 account/signing/device 승인 필요. OS accounts/private DB/browser profile/Keychain/TCC 준비 없이 live credential을 활성화하지 않는다.
- [ ] **WP-15 / P0 — Use-only CredentialBroker.** `packages/credentials/**`의 use-only client와 native helper의 Keychain broker. `credential_use(intentHash, permitId, credentialRef, recipeId)`를 요청 identity/worker/scope/expiry/recipe에 bind한다. Generic get/list/search API를 만들지 않는다. Broker는 상품/주문 business orchestration을 소유하지 않으며 credential-aware worker가 내부 사용하도록 검증한다. Raw credential이 Adapter/Core/MCP로 돌아가는 경로와 argv/env 전달을 금지한다. Dependencies: WP-09 + WP-14 contract. RED: arbitrary ref/wrong peer/changed permit/replay/locked vault. Surface QA: Gate A synthetic boundary driver; 실제 Keychain 합성 credential 시험은 WP-20.
- [ ] **WP-16 / P0 — AuthSessionKeeper + persistent browser worker.** `packages/automation/**` session/provider components, native helper와 credential-owning workers. Provider가 실제 지원하는 token 방식에 맞춰 refresh single-flight와 rotation/crash recovery를 구현한다. Browser fallback은 HAAR 전용 managed persistent profile을 account/provider별로 유지하고 Core에는 opaque auth status만 반환한다. 평상시 반복 login을 요구하지 않는다. Mandatory human challenge만 WAITING_USER, 복구 후 effect를 먼저 reconcile한다. Dependencies: WP-14…15 및 WP-17의 공식 auth capability 조사. RED: refresh race/rotation crash/expiry/profile reopen/challenge/resume duplication. Surface QA: 합성 API/session과 실제 browser fixture profile 재개방; 개인 기본 profile/실계정 사용 금지. Native 및 Shopify auth 지속성은 WP-20…22에서 별도 입증한다.
- [ ] **WP-17 / P1 — ShopifyAdapter + credential-aware transport/provider capability matrix.** MAC-04 router/provider abstraction에 맞춘 proposed `packages/automation/src/providers/shopify/**`의 adapter 및 credential-owning transport worker. Package placement와 권한 경계는 WP-07에서 확정하고 분리 필요 시 integrator가 additive worker package를 등록한다. Business 의미는 adapter, 최종 위험 판정은 Policy, credential authorization은 Broker, authenticated request는 transport, auth 유지란 Keeper의 책임이다. Worker는 고정 공식 endpoint/허용 GraphQL operation template/strict parameters만 사용하며 임의 URL/GraphQL/redirect로 credential을 전송하지 않는다. Sanitized typed result/EffectReceipt만 반환한다. Dependencies: WP-08…09 + WP-14…15 contracts; 공식 API 조사 자체는 WP-07과 병렬 가능. RED: action/risk downgrade/SSRF/store drift/raw error/secret pass-through/unproven write replay. Surface QA: fixture API server에 실제 worker request를 보내고 외부-effect counter 및 sanitized receipt를 대조한다.

**WP-17 discovery output (구현 전에 확정):** pinned Shopify API version; 사용 가능한 merchant app/auth/token mode와 최소 scopes; 자동 refresh 지원/rotation/expiry/revocation semantics; action별 API/connector/browser 지원 여부; 공식 idempotency 보장·보존 window; action별 atomic expected-state/CAS 지원; rate/quantity/resource limit; customer PII projection/redaction; reconciliation query/NOT_APPLIED proof. Shopify 전체에 refresh/idempotency/version 조건부 갱신이 있다고 가정하지 않는다. 문서와 test store에서 보장을 입증할 수 없는 mutation은 비가용 또는 제한 상태로 유지한다. 사전 read만으로 atomic compare-and-write가 보장된다고 표시하지 않는다.

### Phase 4 — HAAR workflows + Gate A

- [ ] **WP-18 / P1 — HAAR business recipes와 local-first draft.** `packages/haar-workflows/**`, `apps/agent/src/haar-composition.ts`. 기존 `haar.product-draft.v1`은 source/assets/copy/render/recheck/bundle의 local-first FIXTURE/READ_ONLY, remoteMutationCount=0, publication=NOT_REQUESTED로 유지한다. 상품 생성/수정·재고·주문처리 등은 별도 typed recipe/action으로 등록하고 WP-09/17 계약을 소비한다. 결제/정산/취소/환불/고객 메시지/삭제도 policy+recovery test matrix에 포함하지만 live 자동 활성화하지 않는다. API 미지원/불충분 grant는 안전한 unavailable로 반환하며 성공을 가정하지 않는다. Dependencies: WP-12 + WP-17 fixture + WP-13 fault harness. Surface QA: fixture 자료로 검수 bundle을 생성·열고 receipt와 remote-mutation counter를 확인한다.
- [ ] **WP-19 / P0 gate — Gate A acceptance.** WP-08…18 fixture 계약·정책·fault·auth·dependency·artifact·provider tests를 묶고 synthetic credential leakage를 MCP/SQLite/log/diagnostic/audit/argv/environment/error 및 존재하는 browser trace/debug/screenshot에서 0건으로 입증한다. Dependencies: WP-13…18 fixture completion. 모든 result를 exact commit/release digest·fixture binding·host environment·test/evidence로 기록한다. UNKNOWN은 safe preserved behavior test의 expected observation일 수 있지만 UNKNOWN effect가 CONFIRMED/PASS인 것으로 처리되지는 않는다. SKIP/NOT_RUN은 미충족이다. Target account 격리나 Shopify live success를 fixture pass로 대체하지 않는다.

### Phase 5 — Target Mac native + Gate B + 실제 GPT 경로

- [ ] **WP-20 / P2 — Target Mac native isolation/lifecycle/synthetic auth.** Dependencies: WP-06 reviewed runtime/release + WP-14…16 + Gate A(WP-19), 별도 관리자/account/signing/device/reboot 승인. 실제 target Mac에서 별도 account의 Keychain/broker/profile/cookie/private IPC/files 접근 거부 및 역방향 arbitrary coding command 거부를 입증한다. Core/tunnel/browser restart와 reboot/network/profile reopen을 각각 확인한다. Native 초기 시험은 합성 credential만 사용한다. Credential context는 daemon service와 user-session Keychain을 구분하고 absence/lock/TCC/signing/trust failures를 우회하지 않는다. 이 phase의 synthetic auth pass를 Shopify 인증 지속성 pass로 보고하지 않는다. 모든 생성 QA resource와 임시 credential/profile/service를 teardown 또는 승인된 상주 자원으로 명시한다.
- [ ] **WP-21 / P2 — Gate B: Shopify development/test-store E2E.** Dependencies: Gate A + WP-20 + WP-17 provider capability matrix + 사용자가 등록한 non-production store/app/auth binding과 제한된 test-write authorization. 실제 Shopify API/auth를 사용하여 READ, 허용된 product create/draft 및 bounded inventory write, policy/approval/failure/reconcile를 검증한다. Non-production credential도 동일 broker/격리 보호를 적용한다. 실제 access-token expiry/browser-session expiry/profile reopen/core/tunnel/browser restart/network/reboot 가능 시나리오를 각각 검증한다. Test-store high-risk가 플랫폼에서 불가능하면 fixture proof와 native/test-store proof를 구분하고 NOT_RUN을 pass로 계산하지 않는다. 정상적인 인증은 무인 복구되고 human challenge는 WAITING_USER→reconcile→checkpoint resume로 간다.
- [ ] **WP-22 / P2 — 실제 GPT→target Mac Operations/Coding E2E.** Dependencies: WP-20 + WP-21 + actual GPT/ChatGPT MCP connector/tunnel binding 및 승인된 disposable Coding test repository. GPT → tunnel-client → localhost authenticated MCP → Policy/Approval → task/domain worker → Shopify test store → EffectReceipt → audit/task → GPT의 전체 trace를 확인한다. Coding 경로는 격리 account에서 allowlisted task→worktree→shell/build/test→commit→push→remote SHA 확인→PR/CI→sanitized result를 검증한다. #135/#151/#164의 reviewed 실제 포함 상태를 전제로 하고 다른 lane 코드를 재구현하지 않는다. GPT 승인 tool과 human approval authority도 분리 검증한다. Disconnect/reconnect 뒤 요청 retry가 새 duplicate mutation을 만들지 않아야 한다. localhost curl/fixture MCP 성공은 이 gate의 대체 증거가 아니다.

### Phase 6 — HAAR live READ_ONLY와 별도 WRITE/action gates

- [ ] **WP-23 / P2 required — Gate C: HAAR live READ_ONLY.** Dependencies: Gate A + WP-20 native proof + Gate B + WP-22 실제 GPT path, 그리고 **별도 명시적 사용자 승인**. Exact HAAR account/store/allowed reads를 binding하고 product/order 등 승인된 projection으로 조회한다. 전체 tunnel path, credential/session 유지, PII/secret 경계, write refusal를 검증한다. Test evidence를 live evidence와 분리한다. Gate C PASS가 전체 acceptance의 필수 항목이며 승인 미제공이면 NOT_RUN/BLOCKED로 남긴다. 이번 계획 승인은 Gate C activation 승인이 아니다.
- [ ] **WP-24 / P3 optional — Gate D: HAAR live limited WRITE.** Dependencies: Gate C PASS + **새 별도 사용자 승인**. Action/store/resource/parameter/expected-state/quantity/rate 한도를 명시한 low-risk write만 실행한다. 실제 적용 상태와 receipt를 reconcile한다. Gate A/B/C 통과로 자동 활성화하지 않는다.
- [ ] **WP-25 / P3 optional live — High-risk action별 acceptance.** Development/fixture policy/approval/recovery 구현은 WP-09/13/17/18/21에 포함한다. 실제 payment/refund/cancel/large-price/customer-message/delete/config effects는 정확한 action별 별도 gate·승인·권한·test capability 확인 후에만 실행한다. Dependencies: 관련 개발/test 증거 + 필요한 live activation 승인; DENY라면 먼저 별도 policy change. 실제 돈/고객 effect를 일반 E2E 완료의 필수 시험으로 만들지 않는다. 승인되지 않은 high-risk live action은 disabled/DENY 상태가 정상이다.

## 5. Dependency DAG와 병렬 wave

구현 contract와 native/live acceptance 의존성을 구분한다. Contract/fixture-only 작업은 MAC-02를 모두 기다릴 필요가 없지만, MAC-02 파일을 가져와 중복 구현하거나 LAB_ONLY를 변경하면 안 된다.

WP-14는 `.C`(IPC/배포 contract), `.F`(fixture channel), `.N`(실제 native activation)으로 나눈다. WP-17은 `.D`(공식 API/auth capability 조사)와 `.F`(adapter/worker 구현)으로 나눈다. WP-16은 WP-17 전체 완료가 아니라 `.D`의 확인된 auth 계약에 의존한다. WP-15 fixture는 WP-14.C를 소비하며 WP-13 기반 channel 통합은 WP-14.F에서 검증한다. Gate A는 WP-14.F도 포함한다. 이렇게 분리해 auth/transport 및 fault/IPC 사이의 의존성 순환을 피한다.

```text
MAC-02 lane: WP01 B4 ─┐
             WP02 B1 ─┤
             WP03 B2 ─┼──> WP06 A wiring / reviewed integration ─────────┐
             WP04 B3 ─┤                                                │
             WP05 C  ─┘                                                │
                                                                       │
WP07 reviewed common contract/base                                     │
  └─> WP08 types/hash                                                   │
        ├─> WP09 policy/approval ───────────┐                          │
        └─> WP10 persistence ─────────────┼─> WP11 lease/effect         │
                                          └─> WP12 runner/MCP            │
WP07/WP08/WP09 ─> WP14 IPC/native contract ─> WP15 broker                │
                                      ├──> WP16 auth/session fixture    │
                                      └──> WP17 Shopify fixture         │
WP11/WP12 ─> WP13 faults/dependency fixture                              │
WP12/WP13/WP17 ─> WP18 workflows                                        │
WP13…WP18 fixture complete ─> WP19 Gate A ─> WP20 native proof <──────────┘
WP17 capability matrix + WP20 ─> WP21 Gate B
WP20/WP21 + actual GPT binding ─> WP22 GPT Operations/Coding E2E
WP19/WP20/WP21/WP22 + separate approval ─> WP23 Gate C READ_ONLY
WP23 + new separate approval ─> WP24 Gate D limited WRITE (optional)
Relevant test evidence + action gate/approval ─> WP25 high-risk live (optional)
```

| Wave | 병렬 가능한 작업 | 다음 wave/활성화 조건 |
| --- | --- | --- |
| 0 | 각 최신 CLAIM/remote head/파일 ownership 점검, WP-07 inventory, WP-17 공식 API capability 조사, target readiness 조사 | 공통 contract와 소유권 합의. 실제 계정 생성/로그인/설치 없음 |
| 1 | B1/B2/B3/B4/C 각 owner lane, A의 독립 bootstrap/trust 작업; 별도 reviewed common base에서 WP-08 fixture contracts | Contract freeze 후 shared changes는 single writer |
| 2 | WP-09 policy와 WP-10 persistence의 전용 구현, WP-14.C IPC contract | 승인/hash/DB schema/worker authority bind를 함께 검토 |
| 3 | WP-11 effects, WP-15 broker fixture; dependencies 완료 뒤 WP-12 runner, WP-16 auth와 WP-17 Shopify fixture | 한 wave 안에서도 predecessor 완료 전 dependent code 연결 금지 |
| 4 | WP-13 fault harness 완료 뒤 WP-14.F channel 통합 및 WP-18 workflow 검증; WP-06 reviewed latest integration 검증 | 모듈/whole-system fixture proofs를 구분 |
| 5 | WP-19 Gate A | 모든 fixture tests 및 leakage evidence 확보. 아직 native/live PASS 아님 |
| 6 | WP-20 target native isolation/lifecycle proof | WP-06 + Gate A + target readiness/별도 승인 충족 |
| 7 | WP-21 Gate B, 그 결과를 소비하는 WP-22 실제 GPT test-store/Coding E2E | Gate A/B와 native/auth/tunnel proof 모두 필요 |
| 8 | WP-23 Gate C live READ_ONLY | 새 explicit live-read 승인 필요 |
| 9 | WP-24 limited WRITE / WP-25 action gates | 각각 별도 승인. 일반 완료조건을 막는 필수 live-money 시험으로 취급하지 않음 |

같은 wave의 작업이라도 같은 shared 파일·migration 번호·lockfile을 동시에 수정하지 않는다. DAG의 실제 dependency가 wave 번호보다 우선한다.

## 6. 외부 준비 조건과 차단 gate

아래 정보는 아직 확보됐다고 주장하지 않는다. 개발자는 조사/fixture 작업을 계속할 수 있지만 실제 activation 경계를 넘지 않는다.

| 준비 조건 | 필요한 증거/결정 | 차단하는 작업 |
| --- | --- | --- |
| Reviewed common/Mac candidate | 정확한 base/head/release digest, #139 owner 합의, Coding regressions, #151/#164 포함 상태 | shared integration 및 실제 worker 활성화 |
| Target Mac/account/admin approval | macOS/CPU/UID-role map, 별도 Operations/Coding accounts, 관리자 설치와 reboot 승인 | WP-20 native 및 실제 서비스 설치 |
| Native trust | 승인된 signing identity/requirements/release provenance, 실제 peer rejection | CredentialBroker/native profile activation |
| OS/user session | FileVault 유지, Operations user-session availability, Keychain lock/TCC/profile permissions | browser/Keychain native auth readiness |
| Shopify test binding | 실제 nonprod store/app/token model/scopes, pinned API version, 제한된 test mutation authorization | Gate B |
| GPT/tunnel binding | 실제 GPT/ChatGPT에서 사용할 MCP connection, internal auth와 tunnel-client 설정, local enrollment | WP-22 전체 외부 경로 |
| Coding test repository | 임시 또는 승인된 disposable remote, 허용 branch/push/PR/CI scope | 실제 Coding push/PR E2E |
| HAAR live READ_ONLY | 별도 승인과 exact store/account/allowed-read scope/PII projection | Gate C |
| HAAR limited WRITE | 새 별도 승인, action별 limits/expected-state guarantees | Gate D |
| High-risk live action | action별 acceptance 및 사용자 승인, DENY 해제라면 별도 policy change | 관련 실제 돈/고객 effect |

Mac reboot 후 user-session/Keychain/FileVault를 우회해 무인 상태를 꾸미지 않는다. GUI/session 의존 작업과 daemon API availability를 구분하고 사용자 조치가 불가피한 부분만 WAITING_USER로 알린다.

## 7. TDD, Git 납품, 증거와 복구

### 구현 단위의 기본 순서

1. AGENTS/issue/latest base/관련 test를 읽고 기존 suite baseline을 기록한다.
2. 지정 failure scenario를 RED로 재현한다. RED 증거와 실제 surface 재현을 보관한다.
3. 최소 구현 후 package test, root lint/typecheck/test/build를 Node 24 + pnpm 10.34.5 frozen 환경에서 검증한다. Host-specific CI와 target native test는 구분한다.
4. 실제 matching surface를 사용해 동작을 검증한다. 모듈은 import driver, DB는 reopen/query, HTTP worker는 fixture endpoint, CLI는 실제 실행, browser는 managed fixture profile, native는 실제 accounts/IPC, 최종은 실제 GPT tunnel path.
5. Diff 자체 리뷰 및 지정 reviewer가 acceptance와 증거를 대조한다. 실패를 기존 환경 문제라고 할 때는 unchanged baseline 증거를 붙인다. 미검증 native/provider behavior를 PASS로 보완하지 않는다.
6. Task별 branch+worktree, 최소 verified increment commit, push, remote SHA 확인 후 repo mutation lock release, Draft PR과 지정 integration issue에 wiring/test note를 남긴다. PR 생성/CI 대기에는 lock을 유지하지 않는다. Force-push/자동 merge/타 lane rebase/다른 변경 revert는 금지한다.

### Evidence record

각 결과는 다음 필드를 기록한다. 증거 자체에 secret/PII를 포함하지 않는다.

```text
workPackage / scenario / gate
result: PASS | FAIL | SKIP | NOT_RUN | UNKNOWN
commit SHA / exact integrated candidate SHA / release digest
Mac OS/architecture / runtime versions / account-role identity
provider API version / provider-account-store binding digest
policy version / operation hash / expected-state digest / approval reference
test command or actual GPT invocation / sanitized EffectReceipt
sanitized evidence reference / timestamp / teardown receipt
```

`PASS`는 해당 scenario의 관측 조건을 충족했다는 의미다. Expected UNKNOWN preservation test가 PASS여도 그 remote effect는 UNKNOWN 그대로다. Fixture/test-store/target-native/live evidence는 별도 분류한다.

### 중단/복구 전략

- 문제가 생기면 해당 provider/action/profile activation을 차단하고 task/effect/approval/audit 이력을 보존한다.
- Operations ledger를 삭제하거나 오래된 effect를 NOT_APPLIED로 추측해 재실행하지 않는다. Restore/migration rollback도 DB/credential/profile 보존과 schema compatibility 검증을 먼저 한다.
- Provider state proof가 없으면 UNKNOWN과 resource block을 유지하고 reconciliation 경로로 간다.
- Signing/account/auth/trust gates 미충족 시 해당 capability는 unavailable/blocked로 남긴다. 강제 권한 확대·FileVault 해제·TCC 우회·일반 arbitrary command fallback은 없다.
- QA가 만든 프로세스/포트/임시계정 credential/profile/test resource는 teardown하거나 사용자가 승인한 상주 자원으로 전환한 기록을 남긴다.

## 8. 현재 바로 시작할 다음 순서

1. #139 governance 하에서 B3 source concerns와 top-level/restore capability 계약 차이를 공유하고 scoped RED/실제 stopped-failure fixture 작업을 우선 배정한다. 이 계획 작성만으로 issue comment나 CLAIM을 게시하지는 않는다.
2. #146/#147/#149/#141의 최신 CLAIM/branch를 재확인해 한 agent당 한 owner lane을 배정한다. B4 reader 계약은 초기에 고정하되 다른 lane은 전용 fixture로 병렬 진행한다.
3. A는 기존 runtime/trust 작업을 이어가고, 납품된 B/C를 검토한 뒤 latest #144/#138 조합을 검증한다. #160은 재개발하지 않는다.
4. 별도로 WP-07 common-base/authority contract inventory와 WP-17 Shopify capability 조사를 진행한다. Contract가 reviewed되면 MAC-03/04 fixture-only 구현은 MAC-02 완성 전에도 비충돌 경로에서 시작 가능하다.
5. Gate A → target native isolation → Gate B → 실제 GPT E2E → 승인된 Gate C 순서로 올린다. Gate D/high-risk live를 자동 포함하지 않는다.

**최종 완료:** D13의 unit/contract/policy/fault/native/isolation/leakage/test-store/actual-tunnel/restart/persistent-auth/live-READ_ONLY 조건에 각각 증거가 있어야 한다. 이번 계획과 기존 CI만으로 전체 Mac/HAAR 연동을 완료 처리하지 않는다.

## 9. 근거 링크와 상태 구분

- MAC integration: https://github.com/jskjw157/gram-coding-agent/pull/138
- Installer parent: https://github.com/jskjw157/gram-coding-agent/pull/144
- B3 delivery: https://github.com/jskjw157/gram-coding-agent/pull/165
- Governance/ownership: https://github.com/jskjw157/gram-coding-agent/issues/139
- B1/B2/B3/B4/C/A 세부 acceptance: issues #146/#147/#148/#149/#141/#143의 최신 body와 CLAIM.
- Historical #144 verify failure: https://github.com/jskjw157/gram-coding-agent/actions/runs/36573946967
- #165 recorded verify/macOS lifecycle SUCCESS: https://github.com/jskjw157/gram-coding-agent/actions/runs/37153135281 및 https://github.com/jskjw157/gram-coding-agent/actions/runs/37153135299

이 문서의 `CI SUCCESS`는 조회한 GitHub check 사실이고, native/provider acceptance PASS는 아니다. Historical 실행 수치는 이번 계획에서 다시 실행한 baseline/test로 보고하지 않는다. 모든 신규 WP/Gate 실행 상태는 NOT_RUN이다.
