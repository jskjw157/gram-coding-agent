# MAC-04 브라우저·인증·Mac 앱 실행 경계 — 상세 설계

**상태:** DRAFT / REVIEW_REQUIRED / NOT_IMPLEMENTED  
**작성:** 2026-09-23 (Asia/Seoul)  
**범위:** 사용자가 요청한 상세 설계·실행계획 패키지. 실행·설치·계정 접근·병합 승인이 아니다.  
**대응 계획:** `docs/superpowers/plans/2026-09-23-macos-browser-credentials.md`  
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

## 1. 목표와 대안

MAC-03의 `OperationIntent`를 API, Aside, Playwright, Mac 앱에서 **범위가 정해진 동작으로 실행하고 안전한 receipt만 반환**한다. 브라우저가 켜짐, 계정 인증됨, 해당 행위 승인됨은 서로 다른 조건이다.

선택한 구조는 **API/connector → Aside → Playwright → native GUI** 순위의 capability router다. 모든 일을 GUI 좌표 클릭으로 처리하면 계정/결과 확인이 어렵고, 모든 provider를 범용 shell/MCP로 그대로 노출하면 승인 경계가 사라진다. 따라서 provider는 등록된 recipe만 수행하고, 계정·origin·effect·세대·기한을 검사한다. 우선순위는 적합성과 권한이 확인된 후보끼리 적용한다. Aside가 특정 보호 조건을 제공하지 못하면 해당 작업에서는 fallback 또는 사용자 대기로 가며 안전 조건을 낮추지 않는다.

실제 쇼핑몰별 selector/API와 사용자의 계정은 현재 확인되지 않았다. 이 문서는 무조건 성공하는 로그인 절차를 주장하지 않는다. fixture 서버와 고정 recipe로 구현을 검증하고, 실제 서비스 등록은 별도 evidence gate로 제한한다.

## 2. 모듈·프로세스 경계

| 경로/프로세스 | 단일 책임 |
|---|---|
| `packages/automation-contracts/` | provider descriptor, session observation, permit, typed recipe wire schema |
| `packages/automation/` | router, session manager, intent adapter, output sanitizer |
| `packages/automation/src/providers/aside.ts` | 검증된 설치 버전의 MCP/REPL binding, provider vault의 use-only 로그인 |
| `packages/automation/src/providers/playwright.ts` | 전용 persistent profile의 결정적 DOM recipe |
| `packages/automation/src/providers/native.ts` | signed helper로 typed Mac 앱 action 전달 |
| `packages/credentials/` | secret 값 없는 credential-use client와 typed 결과 |
| `platform/macos/operations-helper/` | 서명된 native launcher/XPC helper, user-session·TCC·Keychain·GUI 경계 |
| `apps/agent/src/automation-composition.ts` | MAC-03 adapter 등록과 feature gating |

Core와 터널은 MAC-02 기반을 사용하되 그 LAB_ONLY 배포를 수정하지 않는다. 실제 운영은 별도의 검토된 OPERATIONS 프로필이다. GUI helper는 `gram-agent`의 실제 로그인 세션에서만 실행한다. 사용자 로그아웃, 화면 잠금, TCC 부족, vault 잠김은 각각 독립적인 비가용 이유다.

**격리 선택:** 첫 credential-enabled Mac 프로필에서는 untrusted 코드·shell·빌드 실행 기능을 로드하지 않는다. 기존 코딩 기능은 Gram에서 유지한다. Mac에서 untrusted 코드와 실계정 운영을 함께 쓰려면 별도 VM/실행 계정·IPC·네트워크 격리 인수시험을 통과한 후 기능을 추가한다. 단순 환경변수 제거, 다른 폴더, 같은 uid의 프로세스 분리는 충분한 격리라고 표시하지 않는다. 기존 non-admin 계정을 관리자 계정으로 바꾸지 않는다.

## 3. 공유 계약과 허가

MAC-03의 `OperationIntent`, `Scope`, `ArtifactRef`, `EffectReceipt`, `OperationAdapter`를 import한다. 아래 이름은 신규 계약이며 중복 정의하지 않는다.

```ts
export type ProviderId = 'api' | 'connector' | 'aside' | 'playwright' | 'native';
export type AuthState = 'AUTHENTICATED' | 'SIGNED_OUT' | 'CHALLENGE' | 'VAULT_LOCKED' | 'UNKNOWN';
export interface SessionObservation {
  provider: ProviderId; profileId: string; scope: Scope;
  machineId: string; bootId: string; userSessionId: string;
  browserGeneration: string; auth: AuthState;
  observedAtMs: number; expiresAtMs: number;
}
export interface ProviderDescriptor {
  id: ProviderId; version: string; bindingDigest: string;
  actions: readonly string[]; supportsCancel: boolean;
  enforcesOrigin: boolean; secretSafe: boolean;
  authOwner: 'NONE' | 'ASIDE_VAULT' | 'USER_KEYCHAIN' | 'SERVICE_KEYCHAIN';
}
export interface ActionPermit {
  permitId: string; operationHash: string; provider: ProviderId;
  bindingDigest: string; scope: Scope; recipeDigest: string;
  sessionGeneration: string; fenceEpoch: number;
  expiresAtMs: number; oneUse: true;
}
export interface RoutePlan { provider: ProviderId; bindingDigest: string; permit: ActionPermit }
export type AuthResult = { status: 'AUTHENTICATED'; observation: SessionObservation }
  | { status: 'WAITING_USER'; reason: 'CHALLENGE' | 'VAULT_LOCKED' | 'SIGNED_OUT' }
  | { status: 'REFUSED'; code: string };
```

`ActionPermit`는 secret이 아닌 서명된/인증된 채널에 묶인 행위 허가 내용이다. permit JSON을 제출했다는 것만으로 신뢰하지 않는다. 발급·소비 기록은 trusted authority가 소유하고 MAC-03 operationHash/승인을 대조한다. 사용자/모델이 임의 문자열 permit을 만들어 승인할 수 없다. 일반 웹사이트·모델 응답에 permit을 전달하지 않는다.

Session observation의 최대 수명은 30,000ms다. boot/session/provider/account/browserGeneration 불일치·미래 timestamp·만료는 무효다. permit은 최대 30,000ms, single use이며 원 승인보다 오래 유효할 수 없다. 로그인 갱신, provider 전환, browser crash, 화면 잠금, 승인 취소 때 폐기한다. 이러한 수치는 이 설계의 제안이다.

## 4. 라우팅·실행·복구 순서

1. MAC-03이 intent와 불명확 effect 여부를 확인한다. UNKNOWN이면 mutation 대신 reconcile을 선택한다.
2. service registry에서 action과 정확한 account/store, endpoint/recipe binding을 찾는다. 사용자 입력 URL을 그대로 실행 대상으로 쓰지 않는다.
3. policy·capability·auth·격리 상태가 충족된 provider만 후보가 된다. connector는 현재 연결된 ChatGPT가 실제 실행 가능한 경우만 후보이며 로컬 daemon API와 혼동하지 않는다.
4. API, connector, Aside, Playwright, native 순서로 선택한다. provider를 고른 뒤 account/store를 직접 확인한다.
5. 필요한 lease와 fence를 확인하고 정확한 operationHash에 단회 permit을 발급한다. MAC-03이 DISPATCHING을 durable 기록한 뒤 실행한다.
6. provider는 permit·recipe·origin·account를 효과 직전에 다시 검사한다. 결과를 schema로 제한해 receipt를 돌려준다.
7. timeout/cancel/crash가 외부 변경 후일 수 있으면 UNKNOWN이다. provider 전환으로 같은 쓰기를 즉시 재전송하지 않는다.

READ_ONLY에는 폼 입력 자체가 autosave를 발생시키는 화면도 허용하지 않는다. GET/POST만 보고 읽기/쓰기를 추정하지 않고 서비스별 recipe의 실제 side effect 계약을 사용한다. API가 있는지 모른다는 이유로 임의 GUI 로그인을 시작하지 않는다.

## 5. Origin·recipe·네트워크 경계

라이브 endpoint는 HTTPS의 정확한 scheme/host/port와 허용된 path template로 고정한다. domain suffix 문자열 비교를 사용하지 않는다. URL userinfo, file/data/javascript scheme, 예기치 않은 redirect와 사설/loopback 목적지는 라이브 요청에서 거부한다. localhost는 독립 FIXTURE registry에서만 허용하며 실제 credential scope와 섞이지 않는다.

Login recipe는 top-level origin, credential 입력 frame origin, form 제출 origin을 각각 확인한다. SSO는 미리 등록된 identity-provider 이동 경로만 허용한다. 팝업·새 탭·다운로드 origin도 동일하게 재확인한다. provider가 frame/redirect/출력 차단을 집행하지 못하면 credential 사용을 거부한다.

Recipe는 sealed release에 포함된 고정 ID+버전+digest이며, locator·허용 동작·관찰 schema·effects를 선언한다. 사용자로부터 JavaScript, AppleScript, shell, 임의 CSS 실행 코드를 받지 않는다. 문자열 입력값은 데이터로만 전달한다. selector의 유일성/화면 상태를 확인하고 여러 일치·사라진 버튼·위치 변경은 `UI_CHANGED`로 멈춘다.

## 6. Aside와 Playwright의 실제 역할

Aside 공식 문서는 CLI/MCP/REPL과 결정적 페이지 검사 흐름을 설명한다. 실제 설치 버전의 도구 목록·schema·취소 동작을 capability probe로 기록하고 binding digest를 고정한다. 문서에 없던 MCP 메서드 이름을 만들어 호출하지 않는다. `aside --session`은 웹사이트 인증·task checkpoint·JS 객체 lifetime의 보장이 아니다. [E1]

Aside Password Manager는 provider 소유 use-only autofill로 취급한다. 비밀번호를 우리 broker로 export하거나 Playwright에 복사하지 않는다. 기존 vault 정책을 변경하지 않고 사이트가 사람 확인을 요구하면 기다린다. [E2]

Playwright는 해당 account/provider 전용 persistent profile을 사용하며 다른 provider와 profile 디렉터리를 공유하지 않는다. 기본 개인 Chrome profile은 사용하지 않는다. Playwright 버전과 browser revision은 구현 Task 7에서 선택·고정해 기록한다. 별도 원격 CDP 포트를 공개하거나 browser sandbox를 끄지 않는다. 쿠키/인증 상태는 민감정보이며 Git/diagnostics/일반 백업에 넣지 않는다. [E3,E4]

외부 provider를 통한 추가 AI 추론은 이 계획의 기본 의존성이 아니다. Aside의 결정적 binding이 불가능하고 paid/nested agent 작업만 가능하다면 `CAPABILITY_UNAVAILABLE`로 기록하고 비용·권한을 별도 검토한다. 외부 서비스 entitlement가 자동으로 주어졌다고 가정하지 않는다.

## 7. Native IPC·서명·허가 발급의 구체적 경계

서명된 native **launcher/bridge**와 user-session helper 사이에 XPC를 사용한다. 허용 bundle ID/Team ID/서명 requirement, uid, audit session, 프로세스 generation을 검사한다. 실제 Team ID는 사용자가 승인한 signing identity에서 읽어 enrollment record에 저장하며 임의 예시 Team ID를 신뢰값으로 배포하지 않는다. 코드서명 requirement setter는 하나의 조합된 requirement만 설정하고, 같은 연결에 setter들을 중첩하지 않는다. 코드서명 API 지원은 대상 SDK/OS에서 시험한다. [E5]

**Node 실행파일의 서명만 검사해서 JavaScript 코드를 신뢰하지 않는다.** launcher가 검증된 immutable release의 고정 Node entry를 실행하고 그 자식에게만 상속한 pipe를 bridge 입력으로 쓴다. 임의 JS entry, 임의 executable, 공용 bearer token, 누구나 실행할 수 있는 privileged shim을 제공하지 않는다. bridge는 자식 PID/start identity와 release digest를 검증한다. helper는 bridge의 주장만으로 승인을 발급하지 않고 자체 operationHash/permit 소비 기록 및 로컬 사용자 승인을 검증한다.

Wire envelope: protocolVersion=1, requestId, generation, intentHash, permitId, monotonic sequence, expiresAtMs, typed body. Frame 최대 128KiB; replay/중복 ID/역순 sequence/기한 초과/알 수 없는 command를 거부한다. 사전 handshake는 nonce를 사용하고 user-session 재생성 시 연결·permit을 폐기한다. handshake deadline 2초, 일반 action deadline 30초, 전체 recipe deadline 120초; 시간 초과는 완료 증거가 아니다.

이 구조는 신뢰된 OS/admin/서명된 구성요소를 가정한다. 같은 uid에 이미 임의 악성 코드가 실행되는 상황까지 방어한다고 주장하지 않는다. 그래서 real-credential 프로필의 untrusted coding 비활성화와 변조 불가 배포 검증이 필수다. IPC 시험이 실패하면 임의 localhost HTTP/인증 생략으로 우회하지 않는다.

## 8. Keychain Credential Broker

API는 `credential_use(intentHash, permitId, credentialRef, recipeId)` 하나의 typed 요청이며 secret get이 아니다. credentialRef는 provider/account별 사전 등록 ID다. 임의 Keychain service/account 검색이나 전체 목록 조회를 제공하지 않는다.

사용자 웹 로그인은 user-session broker가 처리한다. daemon용 machine credential은 별도로 검증된 service provider가 맡는다. 두 Keychain 컨텍스트를 하나로 취급하지 않는 것은 부모 설계에서 유지한 제약이며, 대상 native 테스트 전 접근 성공을 주장하지 않는다. [E6]

브로커가 비밀정보를 읽은 뒤 직접 고정 API 요청을 보내거나, broker-owned 인증 worker가 사전 승인된 페이지 필드에 입력한다. 원문이 core/ChatGPT/일반 recipe 로그로 돌아오지 않는다. Playwright 인증 worker가 문자열을 메모리에 보유할 수 있다는 잔여 위험을 인정하고, 다른 코드 실행·tracing·DOM value 덤프·스크린샷·오류 상세 캡처를 금지한다. 비밀 사용 범위가 끝나면 가능한 버퍼를 제거하되 JS 메모리의 완전 zeroization을 보장하지 않는다.

사용자 등록은 로컬 신뢰 UI에서만 수행한다. Touch ID/passkey/CAPTCHA/새 기기 확인을 우회하지 않는다. 비밀번호 시도는 account별 15분에 최대 2회, 초과하면 사람이 복구한다. OAuth refresh는 account별 single-flight, invalid_grant는 즉시 WAITING_USER이며 refresh token을 일반 task DB에 저장하지 않는다. 자동 이메일 OTP 추출·TOTP seed export는 기본 범위 밖이다.

## 9. GUI·파일·출력·중단

Native GUI는 allowlisted 앱/window에서 observe, 선택된 AX element에 activate/type, 사전 승인된 파일 picker 선택, 작업 자료 reveal만 제공한다. action은 window ID+generation+관찰한 element ID에 묶인다. arbitrary global click, Terminal 실행, 설정 앱 보안 변경, 임의 clipboard 읽기는 제공하지 않는다. 향후 서비스 recipe 추가는 같은 경계 안에서 가능하다.

Accessibility/Automation/Screen Recording은 필요한 helper에만 사용자 승인으로 부여한다. GUI session이 없거나 잠기면 action을 중단한다. capture는 등록된 작업 window만 대상으로 하고 인증 dialog가 보이면 금지한다. redaction이 확실하지 않은 화면은 모델에 보내지 않는다. 원격 화면 읽기·이미지 업로드는 별도 데이터 전송 grant가 필요하다.

파일은 MAC-03 ArtifactRef로만 전달한다. 다운로드 최대 20MiB/file, 100MiB/task, 파일명은 generated ID로 바꾸고 MIME·magic/hash·symlink를 검사한다. 자동 실행·archive 추출은 금지한다. 업로드도 source artifact 해시와 승인된 destination을 재검증한다. 전송 중 취소는 remote effect를 없던 일로 만들지 않는다.

로컬 Stop UI는 현재 generation의 모든 permit을 revoke하고 browser/helper 동작을 중지한다. effect는 MAC-03에 UNKNOWN으로 넘겨 대조한다. 사용자 대기 시 browser/GUI lease를 반납하고, 해결되지 않은 mutation의 durable resource block은 유지한다.

## 10. 검증·요구사항 매핑

| ID | 통과 조건 | 계획 Task |
|---|---|---|
| B01 | provider descriptor/version binding, API-first와 능력 기반 fallback | 1,2 |
| B02 | scope·generation·30초 만료·provider switch 재확인 | 3 |
| B03 | origin/frame/redirect/recipe 변경 방어 | 4 |
| B04 | native signed peer+세대+재전송 방지; Node 서명만 신뢰 금지 | 5 |
| B05 | Keychain use-only, 비밀정보 미노출, MFA 대기 | 6 |
| B06 | persistent Playwright 격리와 read-only DOM 계약 | 7 |
| B07 | Aside 실제 schema probe·vault 제한·불가능한 기능 거부 | 8 |
| B08 | GUI/TCC/잠금/window generation과 Stop | 9 |
| B09 | artifact 업/다운로드·redaction·effect 불확실성 | 10 |
| B10 | credential 프로필에서 coding 금지, end-to-end native 증거 | 11 |

fixture tests, real Chromium fixture tests, 실제 Aside binding 테스트, signed XPC/Keychain native tests, 사용자 Mac TCC/계정 승인 테스트를 각각 기록한다. CI에 production secret을 넣지 않는다. native helper 임시 테스트만 통과한 경우 live 서비스 사용 가능으로 표시하지 않는다.

G04-SIGNING, G04-ISOLATION, G04-PROVIDER, G04-AUTH, G04-DEVICE 중 하나라도 실패한 provider/action은 registry에 unavailable로 남는다. 가능한 fixture/문서 작업은 계속할 수 있지만 real credential 시험은 그 경계를 넘지 않는다.
