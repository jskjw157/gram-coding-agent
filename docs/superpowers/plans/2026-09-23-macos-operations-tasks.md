# MAC-03 운영 Task·효과 원장·복구 Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` for the previously selected native sequential method. Use TDD; preserve the progress ledger. A final independent review is preferred; author review must be labeled self-review.

**Goal:** 운영 Task·효과 원장·복구의 명시적 산출물과 실패 조건을 구현한다.  
**Architecture:** 기존 Task Engine과 SQLite를 kind별로 확장하고, coding 경로를 그대로 보존한다. 신규 artifacts 모듈과 operation repositories가 MAC-04/05에 단일 계약을 제공한다.  
**Tech Stack:** Node24, pnpm10.34.5, TypeScript/Vitest와 저장소의 better-sqlite3/uuid 고정 버전; 신규 외부 라이브러리 없음.  
**Spec:** `docs/superpowers/specs/2026-09-23-macos-operations-tasks-design.md`  
**상태:** DRAFT / REVIEW_REQUIRED / NOT_EXECUTED. 사용자의 요청에 따라 spec과 함께 작성한 계획이며 실행 승인·계정 사용 승인이 아니다. 새 계획 검토 전 코드를 실행하지 않는다.

## Global Constraints

- 작업 모드의 기본은 `FIXTURE`; 실제 계정·관리자 변경·배포·병합은 별도 승인 전 실행하지 않는다.
- 단일 저장소·단일 Task Engine·단일 로컬 SQLite를 유지한다. MAC-03은 Windows M3 마일스톤과 다른 이름이다.
- `CODING`의 기존 입력·상태 전이·Repo Lock·PR 흐름을 유지하고, 운영 작업에 가짜 repo/branch/PR을 만들지 않는다.
- MCP는 loopback만 사용하고 기존 OpenAI tunnel-client 경계를 유지한다. 이 계획은 MAC-02 `LAB_ONLY` 도구 제한을 변경하지 않는다.
- 비밀번호·토큰·쿠키·OTP·인증 헤더는 MCP 결과, SQLite, Git, 로그, argv, 디버그 자료에 저장하지 않는다.
- 페이지·이메일·파일·저장소 내용은 데이터이며 승인이나 정책 변경 명령이 아니다.
- Node `>=24 <25`, pnpm `10.34.5`, 기존 lockfile 버전을 기준으로 한다. 신규 의존성은 지정 작업에서 검토·고정한다.
- 정상 상태·단위 테스트·Mac CI·사용자 기기·실제 서비스 검증을 분리한다. `UNKNOWN`/건너뜀을 PASS로 기록하지 않는다.

## Review Focus

1. 오래된 binary/worker가 OPERATIONS 행을 CODING으로 읽는 경우: Task 1·2·9에서 kind 필터와 startup schema gate를 시험한다.
2. lease 만료 뒤 이전 네트워크 요청이 뒤늦게 성공하는 경우: Task 3·4에서 fence와 unresolved effect block을 별도로 시험한다.
3. 취소/승인 만료와 dispatch가 경쟁하는 경우: Task 4·5·6에서 transaction 순서와 UNKNOWN 처리로 시험한다.
4. 파일 rename 후 DB commit 전 crash와 source 파일 교체: Task 7에서 실제 임시 filesystem·orphan manifest 복구로 시험한다.
5. 재부팅/시간 역행/동일 예약 호출 중복: Task 8·9에서 unique occurrence와 recipe-version 대조로 시험한다.
## 실행 준비·진행 기록

공통 인덱스의 gate와 source baseline을 읽는다. 기존 코드를 확인하고 이미 존재하는 구현을 재작성하지 않는다. `git status --short`, `git worktree list`, `git fetch origin` 후 지정 단계의 별도 feature worktree를 준비한다. 문서를 보기 위해 docs 브랜치를 코드에 merge하지 않는다. 실행 시작 당시 spec/plan commit, 의존 PR의 통합 commit, OS/Node/pnpm 버전을 ledger에 기록한다. 로컬 계정·테스트 fixture 외의 서비스 설치는 별도 승인이다.

```bash
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm test && pnpm build
git diff --check
```

기대값: Node24/pnpm10.34.5, 기준 테스트 성공. lockfile 변화는 숨기지 말고 허용한 새 importer/고정 dependency만 검토한다. 현재 브랜치에 없는 기능은 앞 Task의 신규 산출물로 명시한다. 아래 테스트의 공개 함수 이름은 각 Interfaces에서 정의한 신규 API이며, 외부 서비스 API라고 주장하지 않는다. 테스트 첫 실행에는 타입에 맞는 비구현 export만 두고 의미 있는 assertion 실패를 확인한다. import/설치 실패를 RED로 세지 않는다.

## 파일·의존 순서

spec의 모듈표가 책임 경계다. 아래 파일은 해당 Task의 구현과 테스트를 함께 갖는다. 테스트 전용 fixture는 `test-support/` 안에 두며 배포물에서는 제외한다. 각 Task의 완료는 코드가 아니라 검증 명령·exit code·실패 사례·commit을 기록한 시점이다.

### Task 1: 운영 타입·strict 입력·kind별 전이

**Files:** `packages/domain/src/operations.ts`, `packages/domain/src/operations.test.ts`, `packages/domain/src/index.ts`, `packages/task-engine/src/operations/state-machine.ts`  
**Interfaces:** `parseOperationInput(unknown): CreateOperationInput`, `canTransitionOperationStatus(from,to): boolean`, `operationHash(intent): string`; 기존 canTransitionTaskStatus(from,to)는 수정하지 않는다. MAC-03 spec §4의 타입을 export한다.

- [ ] **Step 1 — 실패 테스트 작성.** 아래를 해당 `*.test.ts`에 작성한다. test-only fixture를 같은 파일에 두거나 이 Task가 만드는 test-support 파일에서 명시적으로 import한다.

```ts
import { expect, it } from 'vitest';
import { canTransitionOperationStatus, operationHash } from './operations.js';
import { canTransitionTaskStatus } from './task.js';
it('keeps coding queued behavior while operations can prepare without a repo', () => {
  expect(canTransitionTaskStatus('QUEUED', 'PREPARING')).toBe(false);
  expect(canTransitionOperationStatus('QUEUED', 'PREPARING')).toBe(true);
  expect(canTransitionOperationStatus('COMPLETED', 'RUNNING')).toBe(false);
});
it('rejects missing fields instead of producing a grant hash', () => {
  expect(() => operationHash({} as never)).toThrow('INVALID_OPERATION');
});
```

- [ ] **Step 2 — RED 실행.** `pnpm --filter @gram/domain exec vitest run src/operations.test.ts`. 기대: 아래 불변 조건의 assertion이 비구현 export에서 실패. 실패 원인과 로그를 ledger에 남긴다.
- [ ] **Step 3 — 최소 구현.** 다음 계약/순서를 파일에 구현한다. 아래 코드는 계획의 핵심 로직이며 지금 실행된 제품 코드가 아니다.

```ts
const normal = {
  QUEUED: ['PREPARING'], PREPARING: ['RUNNING', 'WAITING_RESOURCE', 'WAITING_APPROVAL', 'WAITING_USER', 'WAITING_DEPENDENCY'],
  RUNNING: ['VERIFYING', 'WAITING_RESOURCE', 'WAITING_APPROVAL', 'WAITING_USER', 'WAITING_DEPENDENCY', 'RECONCILING'],
  VERIFYING: ['COMPLETED', 'WAITING_USER', 'RECONCILING'],
  WAITING_RESOURCE: ['PREPARING'], WAITING_APPROVAL: ['PREPARING'],
  WAITING_USER: ['PREPARING'], WAITING_DEPENDENCY: ['PREPARING'],
  RECONCILING: ['PREPARING'], COMPLETED: [], FAILED: [], CANCELLED: [],
} as const;
// CANCELLED/FAILED are allowed from nonterminal states only after the
// coordinator proves that no DISPATCHING/UNKNOWN effect remains.
function hashFields(i: OperationIntent) {
  return [1, i.taskId, i.stepKey, i.revision, i.action,
    [i.scope.serviceId, i.scope.accountId, i.scope.storeId, i.scope.resourceType, i.scope.resourceId],
    i.mode, i.effectClass, i.parameterDigest, i.expectedVersion, i.recipeDigest];
}
```

Runtime validation은 spec의 길이·숫자·unknown key·getter/prototype 금지를 적용한다. hashFields를 JSON UTF-8로 SHA-256하되 그 전에 전체 intent와 artifact digest를 검증한다. account/action/recipe/parameter 각각 한 필드만 바꿔 hash가 달라지는 시험을 추가한다. Error에는 입력 원문을 붙이지 않는다.

- [ ] **Step 4 — GREEN·회귀.** `pnpm --filter @gram/domain exec vitest run src/operations.test.ts`를 다시 실행하고 관련 패키지 lint/typecheck/build와 루트 테스트를 실행한다. 기대: 새 실패 사례와 기존 테스트 모두 통과. fixture/native/live의 결과는 별도로 기록한다.
- [ ] **Step 5 — 명시적 커밋.** 아래 경로 외 변경은 diff에서 제외 이유를 확인한다. 파일명 충돌이 있으면 기존 파일을 삭제하지 않고 기준 변경을 기록한다.

```bash
git add "packages/domain/src/operations.ts" "packages/domain/src/operations.test.ts" "packages/domain/src/index.ts" "packages/task-engine/src/operations/state-machine.ts"
git commit -m "feat(domain): define typed operations without changing coding transitions"
```

### Task 2: 추가 migration·원자 task 생성·요청 멱등성

**Files:** `packages/persistence/src/migrations/002_operations_tasks.sql`, `packages/persistence/src/repositories/operation-task-repository.ts`, `packages/persistence/src/repositories/operation-task-repository.test.ts`, `packages/persistence/src/repositories/task-repository.ts`, `packages/task-engine/src/operations/task-service.ts`  
**Interfaces:** `OperationTaskRepository.create(requesterId,input): StoredOperationTask`, `get(requesterId,id): StoredOperationTask|null`; 작업·상세·ingress artifact attach·audit·sequence가 같은 DB transaction이다. 기존 TaskRepository.create/get은 coding 타입을 안전하게 유지하고 getAny는 discriminated union이다.

- [ ] **Step 1 — 실패 테스트 작성.** 아래를 해당 `*.test.ts`에 작성한다. test-only fixture를 같은 파일에 두거나 이 Task가 만드는 test-support 파일에서 명시적으로 import한다.

```ts
import { expect, it } from 'vitest';
import { operationMigrationContract } from './operation-task-repository.js';
it('requires an additive schema instead of rewriting the initial migration', () => {
  const c = operationMigrationContract();
  expect(c.rootTable).toBe('tasks');
  expect(c.sequenceTable).toBe('task_sequence');
  expect(c.operationPublishMode).toBe('NONE');
  expect(c.usesSeparateDatabase).toBe(false);
});
```

- [ ] **Step 2 — RED 실행.** `pnpm --filter @gram/persistence exec vitest run src/repositories/operation-task-repository.test.ts`. 기대: 아래 불변 조건의 assertion이 비구현 export에서 실패. 실패 원인과 로그를 ledger에 남긴다.
- [ ] **Step 3 — 최소 구현.** 다음 계약/순서를 파일에 구현한다. 아래 코드는 계획의 핵심 로직이며 지금 실행된 제품 코드가 아니다.

```ts
// operationMigrationContract() is a read-only schema declaration consumed
// by the migration tests, not a substitute for actually executing SQL.
export function operationMigrationContract() {
  return { rootTable: 'tasks', sequenceTable: 'task_sequence',
    operationPublishMode: 'NONE', usesSeparateDatabase: false } as const;
}
// create transaction order:
// 1 read UNIQUE(requester_id, client_request_id); compare canonical input hash.
// 2 validate requester-owned ingress artifact and attach rights.
// 3 allocate existing task_sequence and UUIDv7; insert OPERATIONS/NONE/null repo.
// 4 insert operation_task_details; attach input; append TASK_CREATED audit.
// 5 read discriminated result; commit together. Throw rolls back every write.
```

기계적 선언 시험 외에 실제 `:memory:` DB와 001+002 migration을 실행하는 통합 시험을 반드시 추가한다. 두 connection의 동일 clientRequestId는 같은 task, 다른 input digest는 REQUEST_CONFLICT다. audit insert 실패를 주입해 tasks/detail/sequence가 모두 복구되는지 확인한다. 기존 coding 행의 count·내용·FK 보존, repo 없는 NONE 행, coding의 NONE 거부를 검사한다.

002가 이미 점유됐으면 다음 미사용 번호로 저장하고 source/plan 매핑을 기록한다. 신규 DDL의 정확한 열·FK·UNIQUE·CHECK는 spec §5와 이 계획의 SQL 부록을 따른다. `StoredTask`를 강제 cast해 NONE을 coding PublishMode로 숨기지 않는다. 예전 runner는 startup schema gate에서 거부한다.

- [ ] **Step 4 — GREEN·회귀.** `pnpm --filter @gram/persistence exec vitest run src/repositories/operation-task-repository.test.ts`를 다시 실행하고 관련 패키지 lint/typecheck/build와 루트 테스트를 실행한다. 기대: 새 실패 사례와 기존 테스트 모두 통과. fixture/native/live의 결과는 별도로 기록한다.
- [ ] **Step 5 — 명시적 커밋.** 아래 경로 외 변경은 diff에서 제외 이유를 확인한다. 파일명 충돌이 있으면 기존 파일을 삭제하지 않고 기준 변경을 기록한다.

```bash
git add "packages/persistence/src/migrations/002_operations_tasks.sql" "packages/persistence/src/repositories/operation-task-repository.ts" "packages/persistence/src/repositories/operation-task-repository.test.ts" "packages/persistence/src/repositories/task-repository.ts" "packages/task-engine/src/operations/task-service.ts"
git commit -m "feat(persistence): add atomic operations records and idempotent intake"
```

### Task 3: 자원 lease·fence·지속 block

**Files:** `packages/task-engine/src/operations/resource-lease.ts`, `packages/task-engine/src/operations/resource-lease.test.ts`, `packages/persistence/src/repositories/operation-lease-repository.ts`  
**Interfaces:** `resourceKeys(scope,providerProfile?,guiSession?): string[]`; `LeaseRepository.acquireAll(taskId,keys,generation,nowMs): LeaseBundle|null`, `heartbeat(bundle,nowMs): boolean`, `release(bundle): void`; LeaseBundle은 token, keys, epochs, expiresAtMs를 가진다.

- [ ] **Step 1 — 실패 테스트 작성.** 아래를 해당 `*.test.ts`에 작성한다. test-only fixture를 같은 파일에 두거나 이 Task가 만드는 test-support 파일에서 명시적으로 import한다.

```ts
import { expect, it } from 'vitest';
import { resourceKeys, validLease } from './resource-lease.js';
it('canonicalizes resource keys without collapsing case-sensitive product IDs', () => {
  const s = { serviceId:'fixture', accountId:'a', storeId:'s', resourceType:'catalog' as const, resourceId:'P1' };
  expect(resourceKeys(s)).not.toEqual(resourceKeys({ ...s, resourceId:'p1' }));
});
it('refuses an expired or stale fenced lease', () => {
  expect(validLease({ epoch:2, expiresAtMs:30000 }, 3, 10000)).toBe(false);
  expect(validLease({ epoch:3, expiresAtMs:30000 }, 3, 30000)).toBe(false);
});
```

- [ ] **Step 2 — RED 실행.** `pnpm --filter @gram/task-engine exec vitest run src/operations/resource-lease.test.ts`. 기대: 아래 불변 조건의 assertion이 비구현 export에서 실패. 실패 원인과 로그를 ledger에 남긴다.
- [ ] **Step 3 — 최소 구현.** 다음 계약/순서를 파일에 구현한다. 아래 코드는 계획의 핵심 로직이며 지금 실행된 제품 코드가 아니다.

```ts
export function validLease(lease: { epoch:number; expiresAtMs:number }, currentEpoch:number, nowMs:number) {
  return Number.isSafeInteger(currentEpoch) && lease.epoch === currentEpoch && nowMs < lease.expiresAtMs;
}
// acquireAll: BEGIN IMMEDIATE; canonical sorted unique keys;
// refuse resource blocks, active incompatible owners and invalid clock state;
// increment retained fence_epoch per key, set token/owner/generation/30s TTL;
// commit only if every key succeeds. On release clear owner/token, retain epoch.
```

resource key는 JSON tuple을 사용해 separator collision을 방지한다. store key와 product key를 함께 생성해 다른 product라도 동일 store mutation은 직렬화한다. 반납 때 행을 삭제해 epoch를 0으로 되돌리지 않는다. 실제 두 DB connection 경쟁·partial acquire rollback·heartbeat token mismatch·human-wait release·UNKNOWN block 보존·same-machine restart를 시험한다. Repo Lock에는 의존하지 않는다.

- [ ] **Step 4 — GREEN·회귀.** `pnpm --filter @gram/task-engine exec vitest run src/operations/resource-lease.test.ts`를 다시 실행하고 관련 패키지 lint/typecheck/build와 루트 테스트를 실행한다. 기대: 새 실패 사례와 기존 테스트 모두 통과. fixture/native/live의 결과는 별도로 기록한다.
- [ ] **Step 5 — 명시적 커밋.** 아래 경로 외 변경은 diff에서 제외 이유를 확인한다. 파일명 충돌이 있으면 기존 파일을 삭제하지 않고 기준 변경을 기록한다.

```bash
git add "packages/task-engine/src/operations/resource-lease.ts" "packages/task-engine/src/operations/resource-lease.test.ts" "packages/persistence/src/repositories/operation-lease-repository.ts"
git commit -m "feat(task-engine): fence operational resource leases and unresolved effects"
```

### Task 4: 외부 효과 원장·확인·재시도

**Files:** `packages/task-engine/src/operations/effect-coordinator.ts`, `packages/task-engine/src/operations/effect-coordinator.test.ts`, `packages/persistence/src/repositories/operation-effect-repository.ts`  
**Interfaces:** `recoverEffectState(state): EffectState`, `EffectCoordinator.dispatch(intent,adapter,signal): Promise<EffectReceipt>` 및 `reconcile(intent,adapter,signal)`; EffectState는 PREPARED/DISPATCHING/CONFIRMED/NOT_APPLIED/UNKNOWN이다.

- [ ] **Step 1 — 실패 테스트 작성.** 아래를 해당 `*.test.ts`에 작성한다. test-only fixture를 같은 파일에 두거나 이 Task가 만드는 test-support 파일에서 명시적으로 import한다.

```ts
import { expect, it } from 'vitest';
import { recoverEffectState, mayDispatch } from './effect-coordinator.js';
it('does not resend a write whose process died after dispatch', () => {
  expect(recoverEffectState('DISPATCHING')).toBe('UNKNOWN');
  expect(mayDispatch('UNKNOWN')).toBe(false);
  expect(mayDispatch('CONFIRMED')).toBe(false);
  expect(mayDispatch('PREPARED')).toBe(true);
});
```

- [ ] **Step 2 — RED 실행.** `pnpm --filter @gram/task-engine exec vitest run src/operations/effect-coordinator.test.ts`. 기대: 아래 불변 조건의 assertion이 비구현 export에서 실패. 실패 원인과 로그를 ledger에 남긴다.
- [ ] **Step 3 — 최소 구현.** 다음 계약/순서를 파일에 구현한다. 아래 코드는 계획의 핵심 로직이며 지금 실행된 제품 코드가 아니다.

```ts
export function recoverEffectState(state: EffectState): EffectState {
  return state === 'DISPATCHING' ? 'UNKNOWN' : state;
}
export function mayDispatch(state: EffectState): boolean { return state === 'PREPARED'; }
// In one local transaction verify lease+grant, consume permit, set DISPATCHING.
// Commit before adapter.execute. Verify returned scope/op/hash before storing.
// Thrown timeout/cancel/crash => UNKNOWN + durable resource block.
// Only adapter.reconcile may resolve UNKNOWN. Preserve stable idempotency key.
```

정상 receipt라도 op/hash/account가 다르면 UNKNOWN으로 남긴다. 실제 DB reopen과 synthetic adapter로 다음 네 crash 지점을 시험한다: PREPARED 후, DISPATCHING commit 후, remote success 후 receipt 전, receipt DB commit 전. 각 경우 adapter 호출 횟수를 검증한다. NOT_APPLIED 판정은 provider evidence 없으면 거부하며 eventual consistency의 일회성 404로 재전송하지 않는다. RETRY는 새 승인 검사와 동일 key로 PREPARED 전환한 경우만 가능하다.

- [ ] **Step 4 — GREEN·회귀.** `pnpm --filter @gram/task-engine exec vitest run src/operations/effect-coordinator.test.ts`를 다시 실행하고 관련 패키지 lint/typecheck/build와 루트 테스트를 실행한다. 기대: 새 실패 사례와 기존 테스트 모두 통과. fixture/native/live의 결과는 별도로 기록한다.
- [ ] **Step 5 — 명시적 커밋.** 아래 경로 외 변경은 diff에서 제외 이유를 확인한다. 파일명 충돌이 있으면 기존 파일을 삭제하지 않고 기준 변경을 기록한다.

```bash
git add "packages/task-engine/src/operations/effect-coordinator.ts" "packages/task-engine/src/operations/effect-coordinator.test.ts" "packages/persistence/src/repositories/operation-effect-repository.ts"
git commit -m "feat(task-engine): journal external effects before dispatch and reconcile unknown outcomes"
```

### Task 5: 기존 승인 체계의 운영 범위 확장

**Files:** `packages/policy/src/operation-policy.ts`, `packages/policy/src/operation-policy.test.ts`, `packages/persistence/src/repositories/operation-approval-repository.ts`  
**Interfaces:** `evaluateOperation(intent,grant,nowMs): ALLOW|NEEDS_APPROVAL|DENY`; `OperationGrant`는 operationHash,expiresAtMs,revokedAtMs,consumedOperationId,authorizerId를 가진다. `consume`는 dispatch transaction 안에서 일회 소비한다.

- [ ] **Step 1 — 실패 테스트 작성.** 아래를 해당 `*.test.ts`에 작성한다. test-only fixture를 같은 파일에 두거나 이 Task가 만드는 test-support 파일에서 명시적으로 import한다.

```ts
import { expect, it } from 'vitest';
import { grantMatches } from './operation-policy.js';
it('refuses expired, revoked, consumed and changed-hash approvals', () => {
  const g = { operationHash:'a'.repeat(64), expiresAtMs:100, revokedAtMs:null, consumedOperationId:null, authorizerId:'local-owner' };
  expect(grantMatches(g, 'a'.repeat(64), 100)).toBe(false);
  expect(grantMatches({ ...g, revokedAtMs:1 }, g.operationHash, 2)).toBe(false);
  expect(grantMatches(g, 'b'.repeat(64), 2)).toBe(false);
});
```

- [ ] **Step 2 — RED 실행.** `pnpm --filter @gram/policy exec vitest run src/operation-policy.test.ts`. 기대: 아래 불변 조건의 assertion이 비구현 export에서 실패. 실패 원인과 로그를 ledger에 남긴다.
- [ ] **Step 3 — 최소 구현.** 다음 계약/순서를 파일에 구현한다. 아래 코드는 계획의 핵심 로직이며 지금 실행된 제품 코드가 아니다.

```ts
export function grantMatches(g: OperationGrant, hash:string, nowMs:number): boolean {
  return g.operationHash === hash && g.revokedAtMs === null
    && g.consumedOperationId === null && nowMs < g.expiresAtMs;
}
// Decision priority: action hard-deny -> DENY; scope mismatch -> DENY;
// read/local-write need data grant; remote-write needs exact one-use approval.
// Validate authority on approval creation; never derive it from request payload.
```

동시에 같은 approval을 소비하는 두 transaction 중 하나만 성공하도록 SQL CAS를 사용한다. 기존 coding ApprovalService 동작은 보존한다. operation_resume 호출/페이지에 삽입된 approved=true/localhost 접속을 승인권자로 인정하지 않는 테스트를 추가한다. 사용자가 바꾼 asset hash·수량·destination·expectedVersion이 같은 승인으로 실행되지 않아야 한다.

- [ ] **Step 4 — GREEN·회귀.** `pnpm --filter @gram/policy exec vitest run src/operation-policy.test.ts`를 다시 실행하고 관련 패키지 lint/typecheck/build와 루트 테스트를 실행한다. 기대: 새 실패 사례와 기존 테스트 모두 통과. fixture/native/live의 결과는 별도로 기록한다.
- [ ] **Step 5 — 명시적 커밋.** 아래 경로 외 변경은 diff에서 제외 이유를 확인한다. 파일명 충돌이 있으면 기존 파일을 삭제하지 않고 기준 변경을 기록한다.

```bash
git add "packages/policy/src/operation-policy.ts" "packages/policy/src/operation-policy.test.ts" "packages/persistence/src/repositories/operation-approval-repository.ts"
git commit -m "feat(policy): bind operational approvals to exact intent and expiry"
```

### Task 6: 같은 엔진의 recipe 실행·wait·취소·recovery

**Files:** `packages/task-engine/src/operations/workflow-runner.ts`, `packages/task-engine/src/operations/workflow-runner.test.ts`, `packages/task-engine/src/operations/recovery.ts`, `packages/task-engine/src/operations/recipe-registry.ts`  
**Interfaces:** `resumeTarget(waitStatus): PREPARING`, `cancelTarget(effectState): CANCELLED|RECONCILING`; `WorkflowRunner.run(taskId,signal)`은 recipe registry의 순서 고정 step들을 checkpoint한다. Recipe는 id/version/digest/steps; step은 key/action/effectClass와 입력 artifact selector를 가진다.

- [ ] **Step 1 — 실패 테스트 작성.** 아래를 해당 `*.test.ts`에 작성한다. test-only fixture를 같은 파일에 두거나 이 Task가 만드는 test-support 파일에서 명시적으로 import한다.

```ts
import { expect, it } from 'vitest';
import { cancelTarget, resumeTarget } from './workflow-runner.js';
it('cancels only after unknown side effects have been reconciled', () => {
  expect(cancelTarget('UNKNOWN')).toBe('RECONCILING');
  expect(cancelTarget('DISPATCHING')).toBe('RECONCILING');
  expect(cancelTarget('CONFIRMED')).toBe('CANCELLED');
  expect(resumeTarget('WAITING_USER')).toBe('PREPARING');
});
```

- [ ] **Step 2 — RED 실행.** `pnpm --filter @gram/task-engine exec vitest run src/operations/workflow-runner.test.ts`. 기대: 아래 불변 조건의 assertion이 비구현 export에서 실패. 실패 원인과 로그를 ledger에 남긴다.
- [ ] **Step 3 — 최소 구현.** 다음 계약/순서를 파일에 구현한다. 아래 코드는 계획의 핵심 로직이며 지금 실행된 제품 코드가 아니다.

```ts
export function cancelTarget(state: EffectState): 'CANCELLED'|'RECONCILING' {
  return state === 'DISPATCHING' || state === 'UNKNOWN' ? 'RECONCILING' : 'CANCELLED';
}
export function resumeTarget(status: OperationStatus): 'PREPARING' {
  if (!status.startsWith('WAITING_')) throw new Error('INVALID_TRANSITION');
  return 'PREPARING';
}
// Recover exact recipe/input/checkpoint versions, never a latest-recipe alias.
// On wait: persist reason+checkpoint+desired state, release transient leases.
// On resume: revalidate capability/account/grant/lease, then continue confirmed steps.
// On cancellation: do not manufacture rollback; use EffectCoordinator reconciliation.
```

Task2/3/4/5 저장소와 함께 실제 DB 재시작 통합 시험을 추가한다. recipe digest가 바뀐 checkpoint, 잘못된 stepKey, 실패 후 completed 강제 전이, disconnected ChatGPT에서 새 판단이 필요한 단계는 거부한다. M3 recovery가 통합돼 있으면 재시작 훅을 거기에 연결하고 두 번째 daemon loop를 만들지 않는다.

- [ ] **Step 4 — GREEN·회귀.** `pnpm --filter @gram/task-engine exec vitest run src/operations/workflow-runner.test.ts`를 다시 실행하고 관련 패키지 lint/typecheck/build와 루트 테스트를 실행한다. 기대: 새 실패 사례와 기존 테스트 모두 통과. fixture/native/live의 결과는 별도로 기록한다.
- [ ] **Step 5 — 명시적 커밋.** 아래 경로 외 변경은 diff에서 제외 이유를 확인한다. 파일명 충돌이 있으면 기존 파일을 삭제하지 않고 기준 변경을 기록한다.

```bash
git add "packages/task-engine/src/operations/workflow-runner.ts" "packages/task-engine/src/operations/workflow-runner.test.ts" "packages/task-engine/src/operations/recovery.ts" "packages/task-engine/src/operations/recipe-registry.ts"
git commit -m "feat(task-engine): resume operation recipes from verified checkpoints"
```

### Task 7: 입력 staging·artifact 저장·보존정책

**Files:** `packages/artifacts/package.json`, `packages/artifacts/src/artifact-store.ts`, `packages/artifacts/src/artifact-store.test.ts`, `packages/persistence/src/repositories/operation-artifact-repository.ts`, `pnpm-lock.yaml`  
**Interfaces:** `stageInput(requesterId,jsonBytes): ArtifactRef`, `ArtifactStore.put(taskId,relativeName,bytes): Promise<ArtifactRef>`, `readAuthorized(requesterId,ref)`; 입력 staging은 최대64KiB JSON이며 requester 소유 ingress로 등록한 뒤 Task2에서 원자 attach한다.

- [ ] **Step 1 — 실패 테스트 작성.** 아래를 해당 `*.test.ts`에 작성한다. test-only fixture를 같은 파일에 두거나 이 Task가 만드는 test-support 파일에서 명시적으로 import한다.

```ts
import { expect, it } from 'vitest';
import { safeArtifactName, mayExpireArtifact } from './artifact-store.js';
it('rejects escape paths and preserves unresolved evidence', () => {
  expect(() => safeArtifactName('../browser/Cookies')).toThrow('UNSAFE_PATH');
  expect(() => safeArtifactName('/etc/passwd')).toThrow('UNSAFE_PATH');
  expect(mayExpireArtifact({ ageDays:31, unresolved:true, generated:true })).toBe(false);
  expect(mayExpireArtifact({ ageDays:31, unresolved:false, generated:true })).toBe(true);
});
```

- [ ] **Step 2 — RED 실행.** `pnpm --filter @gram/artifacts exec vitest run src/artifact-store.test.ts`. 기대: 아래 불변 조건의 assertion이 비구현 export에서 실패. 실패 원인과 로그를 ledger에 남긴다.
- [ ] **Step 3 — 최소 구현.** 다음 계약/순서를 파일에 구현한다. 아래 코드는 계획의 핵심 로직이며 지금 실행된 제품 코드가 아니다.

```ts
export function safeArtifactName(name:string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) || name === '..') throw new Error('UNSAFE_PATH');
  return name;
}
export function mayExpireArtifact(v:{ ageDays:number; unresolved:boolean; generated:boolean }): boolean {
  return v.generated && !v.unresolved && v.ageDays > 30;
}
// Secure writer: validate fixed root+owner+no-follow ancestors; create exclusive
// temporary regular file; bound bytes; hash; fsync; rename; directory sync;
// register immutable manifest in DB. Recover orphan by hash, never overwrite.
```

이 lexical 함수만으로 filesystem safety를 주장하지 않는다. 실제 tmp tree의 symlink/hardlink/중간 교체/잘못된 owner/oversize/DB failure after rename을 검증한다. input staging은 artifacts/ingress/<uuid> 아래 생성하고 arbitrary local path를 MCP로 받지 않는다. private source 원본/Keychain/profile에는 cleanup이 닿지 않아야 한다. 같은 requester의 참조라도 다른 account 자료 전송 grant를 추가 확인한다. package/workspace export와 새 importer만 함께 만든다.

- [ ] **Step 4 — GREEN·회귀.** `pnpm --filter @gram/artifacts exec vitest run src/artifact-store.test.ts`를 다시 실행하고 관련 패키지 lint/typecheck/build와 루트 테스트를 실행한다. 기대: 새 실패 사례와 기존 테스트 모두 통과. fixture/native/live의 결과는 별도로 기록한다.
- [ ] **Step 5 — 명시적 커밋.** 아래 경로 외 변경은 diff에서 제외 이유를 확인한다. 파일명 충돌이 있으면 기존 파일을 삭제하지 않고 기준 변경을 기록한다.

```bash
git add "packages/artifacts/package.json" "packages/artifacts/src/artifact-store.ts" "packages/artifacts/src/artifact-store.test.ts" "packages/persistence/src/repositories/operation-artifact-repository.ts" "pnpm-lock.yaml"
git commit -m "feat(artifacts): store scoped immutable operation evidence and intake"
```

### Task 8: KST durable 예약과 놓친 실행 처리

**Files:** `packages/task-engine/src/operations/schedule.ts`, `packages/task-engine/src/operations/schedule.test.ts`, `packages/persistence/src/repositories/operation-schedule-repository.ts`  
**Interfaces:** `classifyOccurrence(dueMs,nowMs): RUN|EXPIRED|FUTURE`, `ScheduleRepository.claimLatest(scheduleId,nowMs): Occurrence|null`; daily HH:mm Asia/Seoul만 허용한다. occurrence key는 scheduleId와 UTC due다.

- [ ] **Step 1 — 실패 테스트 작성.** 아래를 해당 `*.test.ts`에 작성한다. test-only fixture를 같은 파일에 두거나 이 Task가 만드는 test-support 파일에서 명시적으로 import한다.

```ts
import { expect, it } from 'vitest';
import { classifyOccurrence, allowedScheduleEffect } from './schedule.js';
it('expires old runs and refuses scheduled live writes', () => {
  expect(classifyOccurrence(0, 86400001)).toBe('EXPIRED');
  expect(classifyOccurrence(100, 99)).toBe('FUTURE');
  expect(classifyOccurrence(0, 100)).toBe('RUN');
  expect(allowedScheduleEffect('REMOTE_WRITE')).toBe(false);
});
```

- [ ] **Step 2 — RED 실행.** `pnpm --filter @gram/task-engine exec vitest run src/operations/schedule.test.ts`. 기대: 아래 불변 조건의 assertion이 비구현 export에서 실패. 실패 원인과 로그를 ledger에 남긴다.
- [ ] **Step 3 — 최소 구현.** 다음 계약/순서를 파일에 구현한다. 아래 코드는 계획의 핵심 로직이며 지금 실행된 제품 코드가 아니다.

```ts
export function classifyOccurrence(dueMs:number, nowMs:number) {
  if (!Number.isSafeInteger(dueMs) || !Number.isSafeInteger(nowMs)) throw new Error('INVALID_TIME');
  return nowMs < dueMs ? 'FUTURE' : nowMs-dueMs > 86400000 ? 'EXPIRED' : 'RUN';
}
export function allowedScheduleEffect(effect: EffectClass): boolean { return effect !== 'REMOTE_WRITE'; }
// Convert validated KST daily time to due UTC; unique claim transaction;
// coalesce only latest missed occurrence, mark older ones EXPIRED; never recreate
// an existing occurrence after clock rollback. Use the engine's recovery loop.
```

정상/누락/중복 scheduler process/시간 역행/서버 재부팅/recipe 변경을 실제 DB unique 제약으로 시험한다. 24시간 경계는 정확히 24시간까지 허용하고 초과는 expire다. 기존 scheduler 통합 시 별도 polling daemon을 복제하지 않는다. missed payment/refund/send는 지원 recipe가 아니므로 schedule parser 단계에서 거부한다.

- [ ] **Step 4 — GREEN·회귀.** `pnpm --filter @gram/task-engine exec vitest run src/operations/schedule.test.ts`를 다시 실행하고 관련 패키지 lint/typecheck/build와 루트 테스트를 실행한다. 기대: 새 실패 사례와 기존 테스트 모두 통과. fixture/native/live의 결과는 별도로 기록한다.
- [ ] **Step 5 — 명시적 커밋.** 아래 경로 외 변경은 diff에서 제외 이유를 확인한다. 파일명 충돌이 있으면 기존 파일을 삭제하지 않고 기준 변경을 기록한다.

```bash
git add "packages/task-engine/src/operations/schedule.ts" "packages/task-engine/src/operations/schedule.test.ts" "packages/persistence/src/repositories/operation-schedule-repository.ts"
git commit -m "feat(task-engine): persist bounded KST operation schedules"
```

### Task 9: MCP·앱 조립·회귀·통합 완료 검증

**Files:** `packages/mcp/src/tools/operation-tools.ts`, `packages/mcp/src/tools/operation-tools.test.ts`, `apps/agent/src/operations-composition.ts`, `apps/agent/src/operations-composition.test.ts`, `docs/operations/macos-operations-tasks.md`  
**Interfaces:** `operationTools(profile): readonly string[]`, typed handlers stage/create/get/cancel/resume/artifacts. `OPERATIONS_FIXTURE` 조립은 Task2/6/7/8을 주입하고 LAB_ONLY는 agent_health만 유지한다.

- [ ] **Step 1 — 실패 테스트 작성.** 아래를 해당 `*.test.ts`에 작성한다. test-only fixture를 같은 파일에 두거나 이 Task가 만드는 test-support 파일에서 명시적으로 import한다.

```ts
import { expect, it } from 'vitest';
import { operationTools } from './operation-tools.js';
it('does not broaden the lab or expose an approval bypass', () => {
  expect(operationTools('LAB_ONLY')).toEqual(['agent_health']);
  expect(operationTools('OPERATIONS_FIXTURE')).toContain('operation_create');
  expect(operationTools('OPERATIONS_FIXTURE')).not.toContain('secret_get');
  expect(operationTools('OPERATIONS_FIXTURE')).not.toContain('operation_approve');
});
```

- [ ] **Step 2 — RED 실행.** `pnpm --filter @gram/mcp exec vitest run src/tools/operation-tools.test.ts`. 기대: 아래 불변 조건의 assertion이 비구현 export에서 실패. 실패 원인과 로그를 ledger에 남긴다.
- [ ] **Step 3 — 최소 구현.** 다음 계약/순서를 파일에 구현한다. 아래 코드는 계획의 핵심 로직이며 지금 실행된 제품 코드가 아니다.

```ts
export function operationTools(profile:string): readonly string[] {
  if (profile === 'LAB_ONLY') return ['agent_health'];
  if (profile !== 'OPERATIONS_FIXTURE') throw new Error('PROFILE_NOT_APPROVED');
  return ['agent_health','operation_input_stage','operation_create','operation_get',
    'operation_cancel','operation_resume','operation_artifacts'];
}
// Every handler derives requester from authenticated context, not JSON fields.
// Validate strict input; call typed service; return redacted view/artifact refs.
// UI approval authority and fixture test authority are never MCP caller fields.
```

완료 통합 시험: input stage→repo 없는 task→resource wait→resume→fixture read→artifact→COMPLETED, db reopen 후 상태 유지, 다른 requester 접근 거부, concurrent cancel/dispatch 처리. 모든 기존 coding 테스트, M2 publishing exact-remote-confirm/Repo Lock/PR-CI lock-free 회귀를 실행한다. 문서에 Task별 RED/GREEN, migration 매핑, 실제 HEAD, native 건너뜀, independent/self review 차이를 남긴다. 실제 모델 도구 등록·검증 JSON schema까지 검사하고 단순 이름 리스트 시험만으로 완료하지 않는다.

- [ ] **Step 4 — GREEN·회귀.** `pnpm --filter @gram/mcp exec vitest run src/tools/operation-tools.test.ts`를 다시 실행하고 관련 패키지 lint/typecheck/build와 루트 테스트를 실행한다. 기대: 새 실패 사례와 기존 테스트 모두 통과. fixture/native/live의 결과는 별도로 기록한다.
- [ ] **Step 5 — 명시적 커밋.** 아래 경로 외 변경은 diff에서 제외 이유를 확인한다. 파일명 충돌이 있으면 기존 파일을 삭제하지 않고 기준 변경을 기록한다.

```bash
git add "packages/mcp/src/tools/operation-tools.ts" "packages/mcp/src/tools/operation-tools.test.ts" "apps/agent/src/operations-composition.ts" "apps/agent/src/operations-composition.test.ts" "docs/operations/macos-operations-tasks.md"
git commit -m "feat(mcp): expose scoped operations with isolated fixture composition"
```

## 추가 task 간 의존 확인

Task 2의 input artifact 등록 테스트는 같은 migration의 `operation_artifacts`에 실제 fixture 행을 삽입한다. 이는 아직 없는 ArtifactStore를 성공한 것처럼 mock하는 것이 아니다. Task 7에서 공개 staging API와 연결한 뒤 Task 9가 생성부터 재실행한다. Task 4의 provider는 test-only counting adapter로 효과의 순서/중복만 검증하고 실제 네트워크 인증 구현을 주장하지 않는다. Task 6은 Task 7 전까지 artifact port 계약으로 실행하며 Task 9에서 실제 file store를 포함한다.

## SQL 부록 — 신규 테이블의 최소 명시 계약

아래 DDL은 계획 코드이며 아직 DB에 실행되지 않았다. 실제 migration 테스트는 FK와 기존 행 보존까지 검증한다. 타임스탬프/외부 입력은 위 typed service에서 검증하고 DB에서도 주요 enum을 제한한다.

```sql
CREATE TABLE operation_artifacts (
 id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id), requester_id TEXT NOT NULL,
 relative_path TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL CHECK(length(sha256)=64),
 media_type TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes>=0),
 classification TEXT NOT NULL, retention_state TEXT NOT NULL,
 intake_state TEXT NOT NULL CHECK(intake_state IN ('INGRESS','ATTACHED')),
 created_at TEXT NOT NULL
) STRICT;
CREATE TABLE operation_task_details (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id), requester_id TEXT NOT NULL,
 workflow_id TEXT NOT NULL, workflow_version INTEGER NOT NULL CHECK(workflow_version>0),
 mode TEXT NOT NULL CHECK(mode IN ('FIXTURE','READ_ONLY','WRITE_APPROVED')),
 scope_json TEXT NOT NULL, input_artifact_id TEXT NOT NULL REFERENCES operation_artifacts(id),
 client_request_id TEXT NOT NULL, input_digest TEXT NOT NULL,
 wait_reason TEXT, checkpoint_revision INTEGER NOT NULL DEFAULT 1,
 worker_generation TEXT, desired_state TEXT,
 UNIQUE(requester_id,client_request_id)
) STRICT;
CREATE TABLE operation_effects (
 operation_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
 step_id INTEGER NOT NULL REFERENCES task_steps(id), revision INTEGER NOT NULL,
 operation_hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN
 ('PREPARED','DISPATCHING','CONFIRMED','NOT_APPLIED','UNKNOWN')),
 idempotency_key TEXT NOT NULL UNIQUE, dispatch_attempt INTEGER NOT NULL DEFAULT 0, provider_ref TEXT,
 receipt_artifact_id TEXT REFERENCES operation_artifacts(id),
 UNIQUE(task_id,step_id,revision)
) STRICT;
CREATE TABLE operation_leases (
 resource_key TEXT PRIMARY KEY, owner_task_id TEXT REFERENCES tasks(id),
 machine_id TEXT, boot_id TEXT, worker_generation TEXT, token TEXT,
 fence_epoch INTEGER NOT NULL DEFAULT 0 CHECK(fence_epoch>=0),
 lease_until_ms INTEGER NOT NULL DEFAULT 0, heartbeat_ms INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE operation_resource_blocks (
 resource_key TEXT NOT NULL, operation_id TEXT NOT NULL REFERENCES operation_effects(operation_id),
 PRIMARY KEY(resource_key,operation_id)
) STRICT;
CREATE TABLE operation_approval_details (
 approval_id INTEGER PRIMARY KEY REFERENCES approvals(id), operation_hash TEXT NOT NULL,
 expires_at_ms INTEGER NOT NULL, authorizer_id TEXT NOT NULL,
 consumed_operation_id TEXT REFERENCES operation_effects(operation_id), revoked_at INTEGER
) STRICT;
CREATE TABLE operation_schedules (
 id TEXT PRIMARY KEY, requester_id TEXT NOT NULL, workflow_id TEXT NOT NULL,
 workflow_version INTEGER NOT NULL, input_artifact_id TEXT NOT NULL REFERENCES operation_artifacts(id),
 grant_ref TEXT NOT NULL, local_time TEXT NOT NULL, time_zone TEXT NOT NULL CHECK(time_zone='Asia/Seoul'),
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1))
) STRICT;
CREATE TABLE operation_occurrences (
 schedule_id TEXT NOT NULL REFERENCES operation_schedules(id), due_at_utc TEXT NOT NULL,
 task_id TEXT REFERENCES tasks(id), status TEXT NOT NULL CHECK(status IN ('CLAIMED','EXPIRED','COMPLETED')),
 PRIMARY KEY(schedule_id,due_at_utc)
) STRICT;
ALTER TABLE task_steps ADD COLUMN recipe_digest TEXT;
ALTER TABLE task_steps ADD COLUMN input_digest TEXT;
ALTER TABLE task_steps ADD COLUMN checkpoint_version INTEGER;
ALTER TABLE task_steps ADD COLUMN operation_id TEXT;
CREATE TRIGGER operations_shape_insert BEFORE INSERT ON tasks
WHEN NEW.task_type='OPERATIONS' AND
 (NEW.publish_mode!='NONE' OR NEW.repo_id IS NOT NULL OR NEW.repo_selector IS NOT NULL OR NEW.direct_main_grant!=0 OR NEW.base_branch IS NOT NULL OR NEW.working_branch IS NOT NULL OR NEW.base_commit IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'INVALID_OPERATION_TASK'); END;
CREATE TRIGGER operations_shape_update BEFORE UPDATE ON tasks
WHEN NEW.task_type='OPERATIONS' AND
 (NEW.publish_mode!='NONE' OR NEW.repo_id IS NOT NULL OR NEW.repo_selector IS NOT NULL OR NEW.direct_main_grant!=0 OR NEW.base_branch IS NOT NULL OR NEW.working_branch IS NOT NULL OR NEW.base_commit IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'INVALID_OPERATION_TASK'); END;
```

receipt 저장은 operation/task/step 일치 여부도 transaction에서 대조한다. 승인 소비의 일회성은 approval_id별 CAS로 보장하며, 확실한 NOT_APPLIED 이후 같은 operation을 재시도할 때 새 approval을 연결할 수 있다. consumed_operation_id에 전역 UNIQUE를 걸어 정당한 재승인을 막지 않는다. effect의 dispatch_attempt는 시도별로 증가하되 operation_id/idempotency_key는 유지한다. schedule input은 재사용 가능한 승인 intake manifest로 유지하고 task 생성 시 task-scoped 복사/참조 권한을 확인한다. retention은 unresolved foreign references를 삭제하지 않는다.

## 완료 보고 형식

O01–O10 각각에 구현 commit·테스트명·실행 환경·결과를 붙인다. 실행하지 않은 native/실계정 시험은 NOT_RUN으로 남긴다. task engine의 standalone fixture end-to-end와 기존 coding 전체 회귀가 성공한 다음 리뷰를 요청하며 자동 병합하지 않는다. 다음 MAC-04는 이 spec의 타입을 그대로 import한다.
