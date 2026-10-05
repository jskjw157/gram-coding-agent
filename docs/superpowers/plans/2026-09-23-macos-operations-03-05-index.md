# MAC-03–05 상세 설계·실행계획 인덱스

**작성일:** 2026-09-23 (Asia/Seoul)  
**상태:** DRAFT / REVIEW_REQUIRED / 문서 작성 완료 후 검토 대상. 구현 완료·실계정 사용·설치·병합 승인이 아니다.  
**문서 브랜치:** `docs/macos-operations-agent-design`, 기존 Draft PR #136.  
**요청:** MAC-02 구현을 일시 멈추고 MAC-03~05의 상세 설계와 실행계획을 먼저 작성한다.

## 1. 파일과 단계별 완료 결과

| 단계 | 상세 설계 | 실행계획 | 작업 수 | 완료 결과 |
|---|---|---|---:|---|
| MAC-03 | `docs/superpowers/specs/2026-09-23-macos-operations-tasks-design.md` | `docs/superpowers/plans/2026-09-23-macos-operations-tasks.md` | 9 | repo 없는 운영 Task, 동일 DB/ID, 승인·lease·효과 대조·artifact·예약 |
| MAC-04 | `docs/superpowers/specs/2026-09-23-macos-browser-credentials-design.md` | `docs/superpowers/plans/2026-09-23-macos-browser-credentials.md` | 11 | API/Aside/Playwright/native 경로, 세션 복구, use-only credential, signed GUI 경계 |
| MAC-05 | `docs/superpowers/specs/2026-09-23-haar-product-draft-workflow-design.md` | `docs/superpowers/plans/2026-09-23-haar-product-draft-workflow.md` | 8 | 상품1개와 승인 이미지의 로컬 초안·검수 패키지, 실제 게시0회 |

총 상세 설계3개·실행계획3개·28개 Task다. 문서가 있다는 것과 각 gate가 실행 가능하다는 것은 다르다. 실제 서비스 endpoint/schema/계정/서명 identity는 사용자 환경에서 확인한 값으로만 등록한다. fixture는 완결된 개발·검증 경로이며 live 성공의 대체 증거는 아니다.

## 2. 현재 저장소 기준과 바뀌지 않은 범위

| 구분 | 확인한 기준 commit | 현재 의미 |
|---|---|---|
| main | `fdf5dda2211e011e473f1c89095b78d7cb565c2f` | M0/M1 기반; 새 Mac 구현이 병합된 상태가 아님 |
| Windows M2 | `c5225dd8b8f6f014ed6dc036abc63e55945d39b6` | 공유 task/policy/persistence 계약을 읽은 기준, 이번 문서 작업에서 수정하지 않음 |
| MAC-01 | `a98c8ff45497f8524bc2ffa9bda19ad60898faf1` | 플랫폼/진단 별도 PR137 |
| MAC-02 | `0e32fd4bccf1fff684b38b11752e4cbcdf8347c7` | PR138 partial; static install/preview 구현, helper trust/live peer 등 남음 |
| 문서의 부모 | `3c643d4c10772d57287af0b401e4219ad7782a34` | 부모 설계·MAC01/02 계획의 이전 documentation head |

MAC-02 다음 재개는 해당 구현 브랜치의 `docs/operations/macos-service-lifecycle.md`를 따른다. 이번 패키지는 그 진행 기록을 덮어쓰지 않는다. 과거 인덱스의 ‘MAC01 미구현’, 계획 상단의 ‘NOT EXECUTED’는 작성 당시 상태이며 현재 branch/PR/코드와 구분한다. 새 MAC03~05는 이번에 처음 상세화한 **미구현 제안**이다.

## 3. 순서와 의존 계약

```text
기존 공통 M2/M3 계약 검토·통합 → MAC-03
MAC-01 + MAC-02 신뢰·수명주기 기반 → MAC-04
MAC-03 + MAC-04 → MAC-05 fixture → 승인된 단일 상품 read-only 검수
```

MAC03/04 순수 계약·fixture 작업은 일부 병렬 가능하지만 공유 코드 통합을 무단 cherry-pick으로 해결하지 않는다. MAC04의 browser/provider 시험은 고유 adapter 계약을 사용하며 MAC03의 효과 원장을 복제하지 않는다. MAC05는 단일 recipe이며 별도 작업 scheduler/browser engine을 만들지 않는다.

| 소비자 | 생산자·계약 | 검사해야 하는 불변 조건 |
|---|---|---|
| MAC04/05 | MAC03 `OperationIntent/Scope/ArtifactRef/EffectReceipt/OperationAdapter` | ID/hash/scope/effectClass 필드명·schemaVersion 일치 |
| MAC04 router | MAC03 approval·lease·effect coordinator | DISPATCHING durable commit 후 실행, permit exact hash·fence·기한 |
| MAC03 runner | MAC04 `AuthResult` | human challenge→WAITING_USER, provider down→WAITING_DEPENDENCY, UNKNOWN effect→RECONCILING |
| MAC05 source | MAC04 verified catalog.read binding | 동일 account/store/product, read-only이며 임시저장도 금지 |
| MAC05 bundle | MAC03 ArtifactStore와 task_steps | input/recipe/revision hash 일치, final bundle 원자 처리 |
| MAC04 helper | MAC02 프로세스·배포 신뢰 및 MAC01 readiness | process alive≠auth ready; Lab profile은 health-only 유지 |
| Task6 installer(MAC02) | MAC02 기존 install manifest/journal read contract | 새 GUI/helper 프로필 활성화를 기존 LAB_ONLY 승인으로 취급하지 않음 |

### 서로 다른 상태 체계

`OperationStatus`는 root 작업 진행, `EffectState`는 특정 부작용, `AuthState`는 provider 인증, `DraftBundle.state`는 로컬 결과 품질이다. 한 상태를 다른 상태로 추정하지 않는다. REVIEW_READY+root COMPLETED는 ‘초안 준비 완료’이며 remote published가 아니다. VAULT_LOCKED는 승인 거부와 구분하고, human resume는 approval 발급이 아니다.

### 추가 공통 내부 타입 계약

- `StoredOperationTask`: id, seq, taskType='OPERATIONS', status:OperationStatus, publishMode='NONE', repoId=null, repoSelector=null와 MAC03 상세 필드. 기존 coding DTO와 discriminated union을 사용한다.
- `Recipe`: id:string, version:number, digest:string, steps:readonly RecipeStep[]. `RecipeStep`: key:string, action:string, effectClass:EffectClass, inputSelector:string. inputSelector는 registry의 고정 필드 이름이며 코드를 평가하지 않는다.
- `EffectState`: PREPARED/DISPATCHING/CONFIRMED/NOT_APPLIED/UNKNOWN. `OperationGrant`: operationHash,expiresAtMs,revokedAtMs,consumedOperationId,authorizerId.
- `LeaseBundle`: taskId,token,generation,keys,epochs,expiresAtMs. keys/epochs는 동일 순서의 읽기 전용 배열이며 일부 키만 취득하지 않는다.
- `ArtifactStore`: stageInput/put/readAuthorized의 생성권한은 requester에서 유래한다. ingress 기록의 task_id는 NULL일 수 있고 task 생성에서 attach한다. 재사용 source는 같은 requester의 허가된 참조로 복사/연결하며 원본 소유권을 빼앗지 않는다.
- `DraftDocument`: title:string,description:string,verifiedAttributes:readonly {name,value,sourceRef}[],assetRefs:readonly ArtifactRef[],issues:readonly string[]. 화면/HTML의 모든 값은 정제·escape한다.

## 4. 명시적 gate: 값이 없으면 안전하게 멈추는 지점

| Gate | 책임자/실행 단계 | 필요한 증거 | 미충족 기본 동작 |
|---|---|---|---|
| G03-BASE | 구현자, MAC03 시작 | 최신 공유계약·통합 commit·coding 회귀 baseline | DB/공통서비스 변경 보류, fixture 설계 검토만 |
| G03-DB | 구현자, MAC03 Task2 | 실제 기존 DB upgrade, FK/행/sequence 보존, downgrade guard | migration 중단·원본 보존 |
| G03-DATA | 사용자+권한층 | requester/scope별 데이터 전송 grant | source 접근·egress 거부 |
| G04-SIGNING | 사용자 signing 소유자+MAC04 Task5 | 실제 Team ID/서명 requirement/native peer 음성시험 | live helper 비활성; 임시서명 fixture만 |
| G04-ISOLATION | 구현자+보안 리뷰, Task11 | real credential 프로필에서 untrusted execution 경로0, 변조검사 | 실계정 credential 등록 금지 |
| G04-PROVIDER | 구현자, Task7/8 | 설치 버전·schema/binding digest·origin/cancel fixture 증거 | 해당 capability unavailable |
| G04-AUTH | 사용자+Task6 | account별 credential-use 권한·vault/OTP 처리 시험 | WAITING_USER, 비밀번호 반복 입력 금지 |
| G04-DEVICE | 사용자+Task9/11 | 실제 GUI session/TCC/locked behavior | native GUI unavailable |
| G05-SOURCE | 사용자+Task7 | 실제 service/account/store/product, 원본자료·사용승인 | FIXTURE 또는 명시 MANUAL_IMPORT |
| G05-ACCEPT | 사용자+Task8 | 산출물 검수, remote mutation0, source drift시험 | 실사용 완료 표시 금지 |

지금 요청은 이 gate들의 **설계/계획 작성**이다. 실제 signing identity, 계정 ID, credential, 유료 작업 권한을 임의로 정하지 않는다. 작성된 새 계획을 검토한 후 이미 선택한 native 순차 실행 방식을 유지할 수 있지만 이 문서 작성 자체를 실행 승인으로 기록하지 않는다.

## 5. 변경·PR·인수인계 규칙

이 패키지는 문서 브랜치/PR136에만 저장한다. 제품코드·M2/MAC01/MAC02·lockfile·workflow·설치·계정·기존 backlog 변경 없음. 후속 구현 브랜치 제안은 `feat/macos-operations-tasks`, `feat/macos-browser-credentials`, `feat/haar-product-draft-workflow`이며 아직 생성하지 않았다. 각 브랜치는 실제 검토·통합된 의존성 기준에서 생성한다.

각 실행계획의 모든 Task는 실패 테스트→RED→최소 구현→GREEN/회귀→명시 커밋으로 진행한다. progress ledger에 spec/plan SHA, task별base/head, 실제 명령/exit, 리뷰·Ruling을 남긴다. 검증 없이 ‘완료’, skipped를 PASS, synthetic fixture를 live acceptance로 표시하지 않는다. 원격 push 확인 후 기존 정책의 lock을 해제하고 PR/CI 대기에는 Repo Lock을 보유하지 않는다. force push/자동 merge/무단 파일 삭제를 하지 않는다.

## 6. 문서 검증의 의미

문서 검사: 6개 대응 spec/plan,28개 Task,27개 요구사항(O10+B10+H7) 연결, 타입/수치/범위 일치, fence·링크·placeholder·비밀정보 점검. TypeScript snippet syntax나 SQL 예시 syntax 검사 결과는 문서 품질 검사이지 새 제품 테스트 실행이 아니다.

새 문서 PR에서 기존 CI가 성공해도 MAC03/04/05의 미작성 제품코드·브라우저·Keychain·GUI·실계정을 검증한 것은 아니다. 리뷰는 작성자 self-review이며 별도 독립 리뷰가 없다면 미실시로 표시한다. 이 패키지의 상세 task들은 모두 NOT_EXECUTED 상태다.

## 7. 원본 저장소 근거

아래는 실제 읽은 코드의 연결 지점이다. 이 URL의 commit과 다른 향후 구현 기준은 다시 대조한다.

- R1: https://github.com/jskjw157/gram-coding-agent/blob/c5225dd8b8f6f014ed6dc036abc63e55945d39b6/packages/task-engine/src/task-service.ts — coding-only 생성 입력.
- R2: https://github.com/jskjw157/gram-coding-agent/blob/c5225dd8b8f6f014ed6dc036abc63e55945d39b6/packages/domain/src/task.ts — 기존 coding 상태 전이.
- R3: https://github.com/jskjw157/gram-coding-agent/blob/c5225dd8b8f6f014ed6dc036abc63e55945d39b6/packages/persistence/src/repositories/task-repository.ts — 기존 ID·sequence·CAS.
- R4: https://github.com/jskjw157/gram-coding-agent/blob/c5225dd8b8f6f014ed6dc036abc63e55945d39b6/packages/persistence/src/migrations/001_initial.sql — 현재 STRICT schema.
- R5: https://github.com/jskjw157/gram-coding-agent/blob/c5225dd8b8f6f014ed6dc036abc63e55945d39b6/packages/policy/src/approval-service.ts — 현재 hash/PENDING 승인 검증.
- R6: https://github.com/jskjw157/gram-coding-agent/blob/0e32fd4bccf1fff684b38b11752e4cbcdf8347c7/docs/operations/macos-service-lifecycle.md — MAC02 partial checkpoint.

## 8. 외부 플랫폼 문서: 확인한 범위만 사용

- E1: https://docs.aside.com/help/developers — CLI/MCP/REPL 제공 및 사용 예시. 특정 설치 버전의 tool schema·권한·취소 보장은 별도 probe다.
- E2: https://docs.aside.com/help/password-manager — agent에 원문 암호를 반환하지 않는 autofill과 사용자 확인 단계. 우리 Keychain API와 동일하다는 근거가 아니다.
- E3: https://playwright.dev/docs/auth — 저장된 인증 상태의 민감성. 쿠키 export가 안전한 기본 복구라는 근거가 아니다.
- E4: https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context — persistent profile 사용 제약. 설치 버전별 실제 동작 검증은 별도다.
- E5: https://developer.apple.com/documentation/xpc/xpc_connection_set_peer_code_signing_requirement%28_%3A_%3A%29 — XPC 서명 요구사항 API 계열. 정확한 SDK 지원·client identity 강제는 native test로 검증한다. 같은 연결에 여러 code-signing requirement setter를 겹쳐 호출하지 않는다. actual SDK 지원과 반환 코드를 확인한다.
- E6: https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains — 부모 설계가 참조한 Keychain 컨텍스트 근거. 이번 브라우저 추출은 JavaScript 안내 페이지만 반환했으므로 본문을 새로 검증했다고 주장하지 않는다. 구현 전 원문/SDK와 user/daemon native 시험이 필요하다.

수치 제한·데이터 schema·순서·gate·모듈 구성은 이번 제안이며 외부 서비스의 보장/정책이나 법적 준수 인증으로 표시하지 않는다.
