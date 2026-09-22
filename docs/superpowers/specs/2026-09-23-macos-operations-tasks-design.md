# MAC-03 운영 작업·자원·복구 — 상세 설계

**상태:** DRAFT / REVIEW_REQUIRED / NOT_IMPLEMENTED  
**작성:** 2026-09-23 (Asia/Seoul)  
**범위:** 사용자가 요청한 상세 설계·실행계획 패키지. 실행·설치·계정 접근·병합 승인이 아니다.  
**대응 계획:** `docs/superpowers/plans/2026-09-23-macos-operations-tasks.md`  
**전체 연결:** `docs/superpowers/plans/2026-09-23-macos-operations-03-05-index.md`

## 근거와 설계 선택의 구분

- **기존 합의:** 단일 저장소, Apple Silicon 전용 상시 Mac, `gram-agent` non-admin, API 우선, Aside 우선/Playwright fallback, FileVault 유지, 비밀정보 원문 미노출. 부모 문서: `docs/superpowers/specs/2026-09-18-macos-operations-agent-design.md` @ `3c643d4c10772d57287af0b401e4219ad7782a34`.
- **확인된 코드:** `main=fdf5dda2211e011e473f1c89095b78d7cb565c2f`, M2 `c5225dd8b8f6f014ed6dc036abc63e55945d39b6`, MAC-01 `a98c8ff45497f8524bc2ffa9bda19ad60898faf1`, MAC-02 `0e32fd4bccf1fff684b38b11752e4cbcdf8347c7`. 이 값은 계획 시점 스냅샷이며 실행 때 다시 읽는다.
- **이번 제안:** 아래 신규 타입·메서드·테이블·수치·파일명은 구현 계약 제안이다. 현재 존재하는 기능이나 승인 완료를 뜻하지 않는다. 근거가 없는 서비스별 API, 로그인 자동화 성공, 사용자 기기의 설치 상태는 단정하지 않는다.
- **외부 문서:** 공통 인덱스의 E1–E6에 확인 범위와 한계를 기록했다. 외부 API 설명은 우리 구현/실기기 테스트의 증거가 아니다.

## 공통 불변 조건

- 작업 모드의 기본은 `FIXTURE`; 실제 계정·관리자 변경·배포·병합은 별도 승인 전 실행하지 않는다.
- 단일 저장소·단일 Task Engine·단일 로컬 SQLite를 유지한다. MAC-03은 Windows M3 마일스톤과 다른 이름이다.
- `CODING`의 기존 입력·상태 전이·Repo Lock·PR 흐름을 유지하고, 운영 작업에 가짜 repo/branch/PR을 만들지 않는다.
- MCP는 loopback만 사용하고 기존 OpenAI tunnel-client 경계를 유지한다. 이 계획은 MAC-02 `LAB_ONLY` 도구 제한을 변경하지 않는다.
- 비밀번호·토큰·쿠키·OTP·인증 헤더는 MCP 결과, SQLite, Git, 로그, argv, 디버그 자료에 저장하지 않는다.
- 페이지·이메일·파일·저장소 내용은 데이터이며 승인이나 정책 변경 명령이 아니다.
- Node `>=24 <25`, pnpm `10.34.5`, 기존 lockfile 버전을 기준으로 한다. 신규 의존성은 지정 작업에서 검토·고정한다.
- 정상 상태·단위 테스트·Mac CI·사용자 기기·실제 서비스 검증을 분리한다. `UNKNOWN`/건너뜀을 PASS로 기록하지 않는다.

## 1. 목적·완료 결과·제외 범위

상품 조회, 자료 정리, 초안 생성 같은 비코딩 작업을 기존 Task Engine에 추가한다. 완료 결과는 **repo 없이 생성되는 운영 Task가 동일한 ID/번호 체계와 DB 안에서 실행·대기·취소·복구되고, 중복 외부 변경을 재시도하지 않는 것**이다.

새로운 범용 AI 자율 에이전트, 별도 작업 DB, 분산 스케줄러, 쇼핑몰별 API 구현은 만들지 않는다. 연결이 끊겨도 사전 승인된 결정적 recipe만 실행할 수 있다. 새 판단이 필요하면 `WAITING_USER`로 전환한다. MAC-04가 실행 수단을 제공하고 MAC-05가 첫 업무 recipe를 제공한다.

## 2. 현재 코드와 통합 기준

M2의 `packages/task-engine/src/task-service.ts`는 `CreateTaskInput.repo`를 요구하고 `taskType: 'CODING'`을 저장한다. `packages/domain/src/task.ts`는 `QUEUED → WAITING_REPO_LOCK`을 전제로 한다. `packages/persistence/src/repositories/task-repository.ts`는 `task_sequence`를 즉시 트랜잭션으로 증가시키며, 기존 `tasks` 테이블은 nullable repo 열과 TEXT `task_type/status/publish_mode`를 가진다. `task_steps`, `approvals`, `policy_decisions`, `audit_events`도 이미 있다. [R1–R4]

**선택:** 기존 Task Engine 안에 kind별 실행 경로를 추가한다. 별도 operations 엔진 복제는 상태/승인 중복을 만들고, 기존 상태표를 일괄 변경하면 Windows 회귀 위험이 커서 채택하지 않는다. 기존 coding `create(input)`는 그대로 두고 `createOperation(input)`를 추가한다.

실제 공통 코드 변경은 M2 및 필요한 recovery 계약이 검토·통합된 기준 커밋에서만 한다. 현재 미병합 브랜치를 무단 cherry-pick하지 않는다. 통합 전에 순수 타입/fixture 실험은 가능하지만 해당 결과를 통합 완료로 기록하지 않는다. 별도 엔진을 만들어 의존성을 우회하지 않는다.

## 3. 모듈과 단일 책임

| 경로 | 책임 |
|---|---|
| `packages/domain/src/operations.ts` | 불변 입력, scope, intent, receipt, lifecycle 타입 |
| `packages/task-engine/src/operations/` | 생성, 상태 전이, recipe 실행, 대기·취소·재개 |
| `packages/persistence/src/repositories/operation-*.ts` | 기존 DB의 운영 상세, lease, effect, checkpoint 저장 |
| `packages/policy/src/operation-policy.ts` | operation 분류 및 기존 승인 체계 확장 |
| `packages/artifacts/` (`@gram/artifacts`) | 작업 범위 파일·해시·검수 증거의 저장/조회 |
| `packages/mcp/src/tools/operation-tools.ts` | strict schema 요청→typed service 호출, redacted 결과 |
| `apps/agent/src/operations-composition.ts` | 의존성 조립, feature gate; adapter가 orchestration을 import하지 않음 |

새 `packages/artifacts`는 문서·이미지·증거의 공통 저장 모듈이다. 기존 `workspaces`는 Git worktree이므로 운영 작업폴더로 재활용하지 않는다. `operations` 디렉터리는 같은 엔진의 기능 분할이지 두 번째 scheduler/DB가 아니다.

## 4. 공통 데이터 계약 v1

다음 타입은 세 단계가 공유할 **신규 계약**이다. ID들은 인증된 registry에서 해석하며 임의 URL/파일 경로로 취급하지 않는다. Runtime parser는 unknown부터 검증한다.

```ts
export type TaskKind = 'CODING' | 'OPERATIONS';
export type ExecutionMode = 'FIXTURE' | 'READ_ONLY' | 'WRITE_APPROVED';
export type EffectClass = 'READ' | 'LOCAL_WRITE' | 'REMOTE_WRITE';
export type OperationStatus = 'QUEUED' | 'PREPARING' | 'RUNNING' | 'VERIFYING'
  | 'WAITING_RESOURCE' | 'WAITING_USER' | 'WAITING_APPROVAL'
  | 'WAITING_DEPENDENCY' | 'RECONCILING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export interface Scope {
  serviceId: string; accountId: string; storeId: string;
  resourceType: 'catalog' | 'asset' | 'draft' | 'report'; resourceId: string;
}
export interface ArtifactRef { id: string; sha256: string; mediaType: string; bytes: number }
export interface CreateOperationInput {
  kind: 'OPERATIONS'; goal: string; workflowId: string; workflowVersion: number;
  mode: ExecutionMode; scope: Scope; input: ArtifactRef; clientRequestId: string;
}
export interface OperationIntent {
  schemaVersion: 1; operationId: string; taskId: string; stepKey: string; revision: number;
  action: string; scope: Scope; mode: ExecutionMode; effectClass: EffectClass;
  parameters: ArtifactRef; parameterDigest: string; expectedVersion: string | null;
  recipeDigest: string;
}
export interface EffectReceipt {
  operationId: string; parameterDigest: string; scope: Scope;
  outcome: 'CONFIRMED' | 'NOT_APPLIED' | 'UNKNOWN';
  providerRef: string | null; evidence: ArtifactRef | null; observedAt: string;
}
export interface OperationAdapter {
  execute(intent: OperationIntent, signal: AbortSignal): Promise<EffectReceipt>;
  reconcile(intent: OperationIntent, signal: AbortSignal): Promise<EffectReceipt>;
}
```

`action`는 문자열이어도 레지스트리에 등록된 enum 값만 허용한다. 초기 값은 `catalog.read`, `artifact.import`, `draft.build`, `artifact.write`, `provider.draft.save`이다. 마지막 값은 효과 처리 시험용이며 실제 계정에서는 기본 DENY다. `WRITE_APPROVED` 모드 문자열은 승인 자체가 아니다.

scope ID/stepKey/workflowId는 ASCII `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`, goal 1–2,000자, SHA-256은 소문자 64자리, version/revision은 양의 safe integer다. unknown key, accessor, prototype 변형, NaN, Infinity, 길이 초과를 거부한다. resourceId는 provider adapter의 canonical ID를 사용하며 임의 소문자 변환으로 서로 다른 상품을 합치지 않는다. task/operation/artifact ID는 UUIDv7; 사람이 보는 task sequence는 기존 원자 증가 방식을 사용한다.

parameterDigest는 정확한 검증된 parameters artifact bytes의 SHA-256이다. 승인 operation hash는 **task ID, step/revision, action, scope, mode, effectClass, parameterDigest, expectedVersion, recipeDigest**를 순서 고정 JSON으로 해시한다. provider 전환도 permit을 재발급해야 한다. 키 정렬되지 않은 임의 JSON.stringify 결과를 프로토콜로 사용하지 않는다.

## 5. DB와 마이그레이션

`tasks`, `task_sequence`, `task_steps`, `approvals`, `policy_decisions`, `audit_events`를 재사용한다. 새 root task 테이블을 만들지 않는다.

| 추가/확장 | 열·제약의 의미 |
|---|---|
| `operation_task_details` | task_id PK/FK, requester_id, workflow_id/version, mode, scope_json, input_artifact_id, client_request_id, input_digest, wait_reason, checkpoint_revision, worker_generation, desired_state |
| `operation_effects` | operation_id PK, task_id/step_id, revision, operation_hash, state, idempotency_key, dispatch_attempt, provider_ref, receipt_artifact_id; UNIQUE(task_id, step_id, revision) |
| `operation_leases` | resource_key PK, owner_task_id nullable, machine_id/boot_id, worker_generation, token, fence_epoch, lease_until_ms, heartbeat_ms |
| `operation_resource_blocks` | resource_key + operation_id UNIQUE; unresolved 외부 효과 차단은 lease TTL과 별개 |
| `operation_artifacts` | id PK, task_id nullable(FK), requester_id, intake_state(INGRESS/ATTACHED), relative_path, SHA-256, media_type, bytes, classification, created_at, retention_state |
| `operation_approval_details` | approval_id PK/FK, operation_hash, expires_at_ms, authorizer_id, consumed_operation_id, revoked_at; 기존 approvals와 결합 |
| `operation_schedules` / `operation_occurrences` | recipe/input/승인 참조, KST daily 설정; UNIQUE(schedule_id, due_at_utc) |
| `task_steps` 확장 | recipe_digest, input_digest, checkpoint_version, operation_id nullable; 기존 coding 행은 변경하지 않음 |

운영 task의 repo_id/repo_selector/branch 관련 열은 NULL, `publish_mode='NONE'`, `direct_main_grant=0`이다. 기존 coding `PublishMode`에 NONE을 섞지 않는다. 저장소 DTO를 `StoredCodingTask | StoredOperationTask`로 나누고 기존 coding 조회는 kind를 검증한 후 반환한다. Coding worker는 OPERATIONS를 잡지 않는다. `TaskStatus` 기존 타입/전이 함수는 그대로 유지하고 operations 전이표를 따로 호출한다.

계획 기준 신규 migration 이름은 `002_operations_tasks.sql`이다. 실행 시 이미 002가 있으면 기존 파일을 수정하지 않고 다음 미사용 번호로 이동한 매핑을 ledger에 남긴다. `001_initial.sql` 수정 금지. 기존 coding 행 checksum/count/FK를 migration 전후 비교한다. triggers로 운영 행의 NONE/NULL 제약을 강제한다. SQLite `STRICT`/FK, 즉시 트랜잭션, compare-and-swap revision을 사용한다. 새 kind가 들어간 DB를 모르는 구버전 binary로 downgrade하지 않는다. 실패 rollback은 transaction 단위이며 실제 작업자료 삭제가 아니다.

생성의 task/상세/input/idempotency/audit는 한 트랜잭션이다. `(requester_id, client_request_id)`가 같고 input digest도 같으면 기존 task를 돌려준다. 여기서 input digest는 goal/workflowId/workflowVersion/mode/scope/input artifact hash의 순서 고정 표현을 해시한다. 같은 key에 다른 input은 `REQUEST_CONFLICT`다. 실패한 생성이 sequence만 소비하거나 일부 task를 남기는 것을 시험한다.

## 6. 상태 전이와 완료의 의미

정상 경로: `QUEUED → PREPARING → RUNNING → VERIFYING → COMPLETED`. 준비에서 자원 대기 시 `WAITING_RESOURCE`, 권한 대기 시 `WAITING_APPROVAL`, 인증/새 판단 대기 시 `WAITING_USER`, helper/네트워크 필요 시 `WAITING_DEPENDENCY`다. resume는 각 wait에서 PREPARING으로만 가고 모든 전제조건을 다시 확인한다. `WAITING_USER.reason`은 AUTH_CHALLENGE, HUMAN_DECISION, VAULT_LOCKED를 구분한다.

각 비종료 상태는 안전한 checkpoint에서 FAILED/CANCELLED로 갈 수 있다. 다만 외부 효과가 발송 중/불명확하면 `desired_state=CANCELLED`만 기록하고 RECONCILING을 거친다. 취소는 이미 발생한 효과를 되돌리지 않는다. RECONCILING 결과가 확정될 때만 취소/실패/재개를 결정한다. 완료는 필수 step receipt·artifact 검증이 전부 확정된 경우만 가능하다. COMPLETED/CANCELLED의 직접 재실행은 금지하고 새 revision/task를 명시적으로 만든다.

## 7. 자원 직렬화·lease·불명확 효과

계정/스토어 변경은 `serviceId/accountId/storeId` 자원, browser context는 `provider/profileId`, 실제 GUI는 machine/user-session 자원으로 직렬화한다. 여러 lease는 canonical key 정렬 후 **하나의 DB 트랜잭션으로 전부 확보하거나 전부 실패**한다. TTL 30,000ms, heartbeat 5,000ms; 이 수치는 신규 제안이며 Repo Lock 수치를 변경하지 않는다.

lease 반납은 owner/token만 비우고 행·fence_epoch는 보존한다. 각 획득은 증가하는 fence_epoch를 가진다. provider worker는 자신의 최신 epoch만 받아 새 동작을 시작한다. TTL이 지났다고 이미 전송한 외부 요청이 취소됐다고 가정하지 않는다. DISPATCHING/UNKNOWN effect가 있으면 resource block이 남고 새 writer는 reconciliation 전까지 금지한다. 외부 SaaS가 fence를 검사한다고 주장하지 않는다.

인증/사람 대기에서는 browser/GUI lease를 반납한다. 불명확한 쓰기가 있다면 지속 block만 남긴다. 같은 operation의 읽기 전용 reconciler만 예외로 접근한다. writer가 죽으면 generation 폐기→연결 차단→effect reconciliation 후 새 writer를 허용한다. 두 Mac/Gram이 같은 계정에 쓰지 않도록 v1은 운영 계정별 단일 machine 등록; live SQLite/브라우저 프로필 공유 금지다.

## 8. 효과 원장과 재시도

효과 상태는 `PREPARED → DISPATCHING → CONFIRMED | NOT_APPLIED | UNKNOWN`이다. DISPATCHING은 네트워크/GUI 호출 **전에** durable commit한다. crash 복구에서 DISPATCHING은 UNKNOWN이다. task/step/revision에 고정된 idempotency key를 재사용한다. 클릭마다 새 key를 만들지 않는다.

읽기/순수 로컬 생성은 결정적 입력 해시로 재실행할 수 있다. 외부 쓰기 timeout/worker crash/provider switch는 먼저 remote query/reconcile을 수행한다. 서버의 공식 idempotency 또는 확실한 remote identity/version 대조가 없으면 UNKNOWN에서 자동 재실행하지 않는다. NOT_APPLIED는 단순 404 한 번이 아니라 provider가 정의한 확실한 부재/미적용 증거여야 한다. eventual consistency로 판단 불가능하면 기다린다. bounded read 재시도는 1/2/4초 총 3회; 429는 Retry-After와 permit 만료를 함께 고려한다.

승인 만료 후 조회 reconciliation은 범위 내에서 가능하지만 mutation 재실행은 새 승인이 필요하다. 계정/값/asset hash/expectedVersion 변경도 재승인이 필요하다. DB 트랜잭션과 SaaS 사이의 exactly-once는 보장하지 않으며, 로컬 중복 dispatch 차단과 UNKNOWN 중단이 보장 범위다.

## 9. 승인과 실행 허가

기존 `ApprovalService`는 hash 일치와 PENDING만 확인한다. [R5] 이번에는 만료·revocation·일회성 소비를 운영 approval 상세와 같은 DB 트랜잭션으로 추가한다. 일반 MCP 호출자가 `approved=true`로 승인할 수 없다. 승인자는 인증된 별도 control 경로/로컬 신뢰 UI에서만 확인한다. `operation_resume`는 승인 발급 기능이 아니다.

READ/LOCAL_WRITE도 scope와 data egress 허가가 있어야 한다. REMOTE_WRITE는 무조건 정확한 operationHash의 승인이 필요하다. 결제·환불·광고예산·가격·고객 메시지·스토어/계정 삭제는 이번 adapter allowlist에 넣지 않는다. 정책은 준비 시점, lease 확보 후, 외부 효과 직전 세 번 검사한다. 차단/거부도 안전한 code와 audit를 남기되 raw payload는 남기지 않는다.

## 10. artifact·privacy·스케줄

입력 생성 전에는 인증된 requester의 `operation_input_stage`가 최대 64KiB의 strict JSON만 받아 `artifacts/ingress/<uuid>/`에 등록한다. 바이너리·임의 파일경로·credential은 이 MCP 입력으로 받지 않는다. Task 생성 transaction에서 ingress artifact의 소유권을 검사해 attach한다. 재사용 source artifact는 원본 소유권을 옮기지 않고 허가된 task-scoped 참조/복사를 만든다.

ArtifactRoot는 `/Users/gram-agent/Library/Application Support/HAAR/Operations/artifacts/<taskId>/`이며 고정 루트 아래 generated 상대 경로만 쓴다. no-follow descriptor 검사, size/hash/소유권 검증, 파일 mode 0600·dir 0700, 임시파일→검증→rename 순서다. 제출 파일명을 경로로 쓰지 않는다. inode race 방지는 기존 MAC-02 reader를 무분별 복제하지 않고 공유 가능한 primitive 추출을 별도 검토한다. metadata와 body는 분리하고 task는 artifact ID만 참조한다.

기본 자료는 제품 데이터다. 원문 고객 PII·인증 자료는 저장하지 않는다. schema allowlist redaction을 우선하고 regex는 보조다. 검수 artifact는 30일 보존 제안, unresolved effect와 감사 참조는 삭제 대상에서 제외한다. 정리는 local generated 파일만 대상으로 하며 browser/keychain/원본 Drive를 건드리지 않는다. 보존정책은 개인정보 법적 준수 보장으로 표시하지 않는다.

v1 durable schedule은 `DAILY`, `HH:mm`, `Asia/Seoul`만 지원한다. read/report/local-draft occurrence는 downtime 뒤 가장 최근 1회만 coalesce, 24시간 초과면 EXPIRED다. live mutation recipe는 schedule 등록을 거부한다. occurrence 생성은 UNIQUE와 트랜잭션으로 중복 차단하며 clock rollback에서도 같은 due_at을 다시 만들지 않는다. 인증 만료 때 비밀정보를 저장해 예약을 이어가는 것이 아니라 WAITING_USER가 된다.

## 11. MCP와 실행 모드

추가 typed tools는 `operation_input_stage`, `operation_create`, `operation_get`, `operation_cancel`, `operation_resume`, `operation_artifacts`다. 각 도구는 requester/task/scope를 재검증한다. task 목록 조회는 다른 requester/account 자료를 섞지 않는다. localhost 소켓 연결은 사용자 권한의 증거가 아니다.

MAC-02 LAB_ONLY release는 `agent_health` 하나만 유지한다. MAC-03 도구는 앱의 별도 `OPERATIONS_FIXTURE` feature profile에서만 조립한다. production profile 활성화는 MAC-04 isolation·broker trust 및 검토된 release가 필요하다. coding shell과 operational credential이 같은 user/runtime에 공존하는 것을 허용하지 않는다.

## 12. 요구사항·인수 기준

| ID | 통과 조건 | 소유 Task |
|---|---|---|
| O01 | repo 없이 생성, 기존 coding API/전이 회귀 없음 | 1,2 |
| O02 | 추가 migration, 기존 행/FK/sequence 보존, 원자 생성 | 2 |
| O03 | multi-resource 원자 획득, stale fence 거부 | 3 |
| O04 | dispatch 전 durable 기록, crash의 UNKNOWN 재전송 없음 | 4 |
| O05 | 만료/revoke/hash 변경/승인 replay 거부 | 5 |
| O06 | human wait lease 반납, 취소 중 효과 대조 후 종료 | 6 |
| O07 | artifact path/size/hash/privacy 경계 | 7 |
| O08 | durable KST schedule coalesce/expire/중복 차단 | 8 |
| O09 | 계정별 MCP authorization, LAB_ONLY 도구 유지 | 9 |
| O10 | recipe version mismatch·upgrade·재부팅 복구, code→browser 무의존 | 6,9 |

완료 기준: 9개 Task의 RED/GREEN·기존 전체 회귀·native/fixture 분리·독립 리뷰 결과·migration 복구 증거. 승인 없는 외부 mutation 0회. MAC-04 없이 fixture recipe의 생성→artifact→resume→완료를 독립 시연할 수 있어야 한다.

## 13. 실행 전 게이트와 제한

공통 M2/M3 인터페이스 통합은 G03-BASE, DB migration 검증은 G03-DB, 실제 데이터 접근은 G03-DATA 게이트다. 게이트 미충족이면 이유·필요 증거·현재 상태를 기록한다. 계획이 있다는 이유로 gate를 PASS로 바꾸지 않는다. Phase별 진행은 공통 인덱스가 관리하고 코드 구현 시 별도 worktree/PR을 사용한다.
