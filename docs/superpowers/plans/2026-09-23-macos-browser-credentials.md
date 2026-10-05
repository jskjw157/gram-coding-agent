# MAC-04 브라우저·Keychain·Mac 앱 제어 Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` for the previously selected native sequential method. Use TDD; preserve the progress ledger. A final independent review is preferred; author review must be labeled self-review.

**Goal:** 브라우저·Keychain·Mac 앱 제어의 명시적 산출물과 실패 조건을 구현한다.  
**Architecture:** MAC-03 OperationAdapter를 capability router로 구현한다. native signed helper가 user-session과 credential-use 경계를 맡고, Aside/Playwright는 독립 profile의 고정 recipe만 실행한다.  
**Tech Stack:** Node24/TypeScript/Vitest, Apple SDK의 C/Swift/XPC·Security·Accessibility, Playwright는 Task 7에서 버전/browser revision 고정, Aside는 설치 버전/schema manifest 고정.  
**Spec:** `docs/superpowers/specs/2026-09-23-macos-browser-credentials-design.md`  
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

1. 서명된 Node 실행파일을 이용한 임의 JS 요청: Task 5·11에서 고정 launcher/child/release와 단회 permit을 검사한다.
2. 올바른 top-level URL 안의 악성 iframe/redirect/autosave: Task 4·7·8에서 frame·destination·effect를 검증한다.
3. profile 전환·재부팅 후 지난 인증 결과 재사용: Task 3에서 boot/session/provider/account를 바꿔 거부한다.
4. vault 잠김·MFA 중단·revoke와 화면 캡처 경쟁: Task 6·9·10에서 비밀정보 0노출과 중단 순서를 검증한다.
5. 취소됐지만 provider의 쓰기가 이미 완료된 경우: Task 2·10·11에서 UNKNOWN receipt와 재전송 금지를 검증한다.
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

### Task 1: provider·session·permit의 strict 계약

**Files:** `packages/automation-contracts/package.json`, `packages/automation-contracts/src/index.ts`, `packages/automation-contracts/src/contracts.test.ts`, `pnpm-lock.yaml`  
**Interfaces:** MAC-04 spec §3 타입을 export한다. `validateProvider(unknown): ProviderDescriptor`, `validatePermit(unknown): ActionPermit`; `Scope/ArtifactRef/OperationIntent/EffectReceipt`는 @gram/domain에서 import한다.

- [ ] **Step 1 — 실패 테스트 작성.** 아래를 해당 `*.test.ts`에 작성한다. test-only fixture를 같은 파일에 두거나 이 Task가 만드는 test-support 파일에서 명시적으로 import한다.

```ts
import { expect, it } from 'vitest';
import { validateProvider } from './index.js';
it('refuses a provider declaration with no executable binding identity', () => {
  expect(() => validateProvider({ id:'aside', version:'unknown' })).toThrow('INVALID_PROVIDER');
  expect(() => validateProvider({ id:'shell', version:'1' })).toThrow('INVALID_PROVIDER');
});
```

- [ ] **Step 2 — RED 실행.** `pnpm --filter @gram/automation-contracts exec vitest run src/contracts.test.ts`. 기대: 아래 불변 조건의 assertion이 비구현 export에서 실패. 실패 원인과 로그를 ledger에 남긴다.
- [ ] **Step 3 — 최소 구현.** 다음 계약/순서를 파일에 구현한다. 아래 코드는 계획의 핵심 로직이며 지금 실행된 제품 코드가 아니다.

```ts
export const providerIds = ['api','connector','aside','playwright','native'] as const;
export const limits = Object.freeze({ observationMs:30000, permitMs:30000,
  frameBytes:131072, handshakeMs:2000, actionMs:30000, recipeMs:120000 });
// Validate closed records before use: descriptor bindingDigest is a SHA-256;
// actions are registered enum entries, booleans are literal booleans;
// permit IDs/generation/epoch/expiry must be present and typed, never truthy casts.
```

새 패키지의 package.json/tsconfig/Vitest/export를 함께 만든다. old/new descriptor schema, unknown key, getter, prototype, oversized frame, unsupported ID를 시험한다. 정확한 버전 문자열은 비교 대상 identity이며 신뢰를 뜻하지 않는다. preview data를 허가로 자동 변환하지 않는다.

- [ ] **Step 4 — GREEN·회귀.** `pnpm --filter @gram/automation-contracts exec vitest run src/contracts.test.ts`를 다시 실행하고 관련 패키지 lint/typecheck/build와 루트 테스트를 실행한다. 기대: 새 실패 사례와 기존 테스트 모두 통과. fixture/native/live의 결과는 별도로 기록한다.
- [ ] **Step 5 — 명시적 커밋.** 아래 경로 외 변경은 diff에서 제외 이유를 확인한다. 파일명 충돌이 있으면 기존 파일을 삭제하지 않고 기준 변경을 기록한다.

```bash
git add "packages/automation-contracts/package.json" "packages/automation-contracts/src/index.ts" "packages/automation-contracts/src/contracts.test.ts" "pnpm-lock.yaml"
git commit -m "feat(automation): define provider and scoped permit contracts"
```

### Task 2: API-first capability router와 effect 연결

**Files:** `packages/automation/src/router.ts`, `packages/automation/src/router.test.ts`, `packages/automation/src/operation-adapter.ts`, `packages/automation/src/permit-store.ts`  
**Interfaces:** `selectProvider(eligible: readonly ProviderId[]): ProviderId|null`; `AutomationAdapter.execute/reconcile`는 MAC-03 OperationAdapter 구현이다. permit-store는 exact hash/provider/binding/generation/fence/expiry의 발급·원자 단회 소비를 담당한다.

- [ ] **Step 1 — 실패 테스트 작성.** 아래를 해당 `*.test.ts`에 작성한다. test-only fixture를 같은 파일에 두거나 이 Task가 만드는 test-support 파일에서 명시적으로 import한다.

```ts
import { expect, it } from 'vitest';
import { selectProvider } from './router.js';
it('prefers API but does not invent an unavailable provider', () => {
  expect(selectProvider(['native','playwright','aside','api'])).toBe('api');
  expect(selectProvider(['playwright','aside'])).toBe('aside');
  expect(selectProvider(['playwright'])).toBe('playwright');
  expect(selectProvider([])).toBeNull();
});
```

- [ ] **Step 2 — RED 실행.** `pnpm --filter @gram/automation exec vitest run src/router.test.ts`. 기대: 아래 불변 조건의 assertion이 비구현 export에서 실패. 실패 원인과 로그를 ledger에 남긴다.
- [ ] **Step 3 — 최소 구현.** 다음 계약/순서를 파일에 구현한다. 아래 코드는 계획의 핵심 로직이며 지금 실행된 제품 코드가 아니다.

```ts
export function selectProvider(eligible: readonly ProviderId[]): ProviderId|null {
  return ['api','connector','aside','playwright','native'].find(p => eligible.includes(p as ProviderId)) as ProviderId|undefined ?? null;
}
// Eligibility BEFORE preference: exact action/scope/binding, authentication,
// isolation, origin controls, secret-safe output, cancellation/reconcile contract.
// execute needs consumed permit tied to durable DISPATCHING; reconcile cannot write.
```

위 순위 시험 외에 policy refusal·Aside missing capability·connector offline·permit replay·잘못된 account를 시험한다. connector live step는 ChatGPT 실행 위치와 연결되어 있을 때만 지원하고 daemon에서 임의 plugin API를 호출하지 않는다. 외부 쓰기 UNKNOWN이면 fallback execute 횟수0을 확인한다. 코드→browser 모듈 직접 의존을 architecture guard로 거부한다.

- [ ] **Step 4 — GREEN·회귀.** `pnpm --filter @gram/automation exec vitest run src/router.test.ts`를 다시 실행하고 관련 패키지 lint/typecheck/build와 루트 테스트를 실행한다. 기대: 새 실패 사례와 기존 테스트 모두 통과. fixture/native/live의 결과는 별도로 기록한다.
- [ ] **Step 5 — 명시적 커밋.** 아래 경로 외 변경은 diff에서 제외 이유를 확인한다. 파일명 충돌이 있으면 기존 파일을 삭제하지 않고 기준 변경을 기록한다.

```bash
git add "packages/automation/src/router.ts" "packages/automation/src/router.test.ts" "packages/automation/src/operation-adapter.ts" "packages/automation/src/permit-store.ts"
git commit -m "feat(automation): route scoped operations without widening permissions"
```

### Task 3: 세션 수명·재인증·재개

**Files:** `packages/automation/src/session-manager.ts`, `packages/automation/src/session-manager.test.ts`  
**Interfaces:** `sessionFresh(observed,current,nowMs): boolean`; current는 provider/profileId/scope/machineId/bootId/userSessionId/browserGeneration이다. `recoverSession`은 AuthResult를 반환하고 MAC-03 wait reason과 연결한다.

- [ ] **Step 1 — 실패 테스트 작성.** 아래를 해당 `*.test.ts`에 작성한다. test-only fixture를 같은 파일에 두거나 이 Task가 만드는 test-support 파일에서 명시적으로 import한다.

```ts
import { expect, it } from 'vitest';
import { sessionFresh } from './session-manager.js';
it('does not reuse the previous provider login after a switch', () => {
  const c = { provider:'aside', profileId:'p', scope:{serviceId:'f',accountId:'a',storeId:'s',resourceType:'catalog',resourceId:'p1'}, machineId:'m',bootId:'b',userSessionId:'u',browserGeneration:'g' };
  const o = { ...c, auth:'AUTHENTICATED', observedAtMs:0, expiresAtMs:30000 };
  expect(sessionFresh(o, { ...c, provider:'playwright' }, 1)).toBe(false);
  expect(sessionFresh(o, c, 30000)).toBe(false);
});
```

- [ ] **Step 2 — RED 실행.** `pnpm --filter @gram/automation exec vitest run src/session-manager.test.ts`. 기대: 아래 불변 조건의 assertion이 비구현 export에서 실패. 실패 원인과 로그를 ledger에 남긴다.
- [ ] **Step 3 — 최소 구현.** 다음 계약/순서를 파일에 구현한다. 아래 코드는 계획의 핵심 로직이며 지금 실행된 제품 코드가 아니다.

```ts
// SessionFresh compares the full ordered identity tuple, never only site hostname.
// Return false for UNKNOWN/signed-out, future observation, lifetime>30000ms,
// now>=expiry, boot/session/provider/profile/generation/scope mismatch.
// On re-auth challenge: revoke permits -> checkpoint -> release GUI/profile lease
// -> WAITING_USER. On resume re-observe account before a new permit is issued.
```

각 tuple field를 하나씩 바꾼 table test와 재부팅·화면잠금·vault잠금·browser crash·로그아웃을 시험한다. 실제 cookie 유지로 authentication 성공을 가정하지 않는다. password attempt budget은 계정별15분2회이며 worker재시작으로 초기화되지 않도록 MAC03 승인/세션 저장 정책에 연결한다. 비밀번호·쿠키는 기록하지 않는다.

- [ ] **Step 4 — GREEN·회귀.** `pnpm --filter @gram/automation exec vitest run src/session-manager.test.ts`를 다시 실행하고 관련 패키지 lint/typecheck/build와 루트 테스트를 실행한다. 기대: 새 실패 사례와 기존 테스트 모두 통과. fixture/native/live의 결과는 별도로 기록한다.
- [ ] **Step 5 — 명시적 커밋.** 아래 경로 외 변경은 diff에서 제외 이유를 확인한다. 파일명 충돌이 있으면 기존 파일을 삭제하지 않고 기준 변경을 기록한다.

```bash
git add "packages/automation/src/session-manager.ts" "packages/automation/src/session-manager.test.ts"
git commit -m "feat(automation): invalidate stale sessions and bound authentication recovery"
```

### Task 4: origin·recipe·frame·redirect 경계

**Files:** `packages/automation/src/origin-policy.ts`, `packages/automation/src/origin-policy.test.ts`, `packages/automation/src/recipe-registry.ts`  
**Interfaces:** `sameAllowedOrigin(raw,allowed): boolean`; `RecipeBinding`은 id/version/digest/action/topOrigins/frameOrigins/submitOrigins/outputSchema/effectClass를 가진다. service registry만 binding을 추가할 수 있다.

- [ ] **Step 1 — 실패 테스트 작성.** 아래를 해당 `*.test.ts`에 작성한다. test-only fixture를 같은 파일에 두거나 이 Task가 만드는 test-support 파일에서 명시적으로 import한다.

```ts
import { expect, it } from 'vitest';
import { sameAllowedOrigin } from './origin-policy.js';
it('rejects suffix spoofing and URL userinfo', () => {
  expect(sameAllowedOrigin('https://shop.example.evil.test/', 'https://shop.example')).toBe(false);
  expect(sameAllowedOrigin('https://x@shop.example/', 'https://shop.example')).toBe(false);
  expect(sameAllowedOrigin('javascript:alert(1)', 'https://shop.example')).toBe(false);
  expect(sameAllowedOrigin('https://shop.example/a', 'https://shop.example')).toBe(true);
});
```

- [ ] **Step 2 — RED 실행.** `pnpm --filter @gram/automation exec vitest run src/origin-policy.test.ts`. 기대: 아래 불변 조건의 assertion이 비구현 export에서 실패. 실패 원인과 로그를 ledger에 남긴다.
- [ ] **Step 3 — 최소 구현.** 다음 계약/순서를 파일에 구현한다. 아래 코드는 계획의 핵심 로직이며 지금 실행된 제품 코드가 아니다.

```ts
export function sameAllowedOrigin(raw:string, allowed:string): boolean {
  try { const u = new URL(raw); const a = new URL(allowed);
    return u.protocol === 'https:' && !u.username && !u.password && u.origin === a.origin;
  } catch { return false; }
}
// Apply also to frame, form submit, popup, redirect and download origin.
// A separate FIXTURE registry permits only its explicit loopback listener.
// Live redirects/private-address resolution must revalidate or refuse.
```

이 origin helper만으로 네트워크 통제를 완료했다고 하지 않는다. fixture server의 cross-origin iframe, HTTP→HTTPS redirect, DNS/private-address mismatch, open redirect, autosave POST, 같은 문구 버튼2개를 시험한다. provider가 요청 집행을 못 하면 credential/live mutation을 unavailable로 표시한다. 선택자를 사용자 코드로 평가하지 않는다.

- [ ] **Step 4 — GREEN·회귀.** `pnpm --filter @gram/automation exec vitest run src/origin-policy.test.ts`를 다시 실행하고 관련 패키지 lint/typecheck/build와 루트 테스트를 실행한다. 기대: 새 실패 사례와 기존 테스트 모두 통과. fixture/native/live의 결과는 별도로 기록한다.
- [ ] **Step 5 — 명시적 커밋.** 아래 경로 외 변경은 diff에서 제외 이유를 확인한다. 파일명 충돌이 있으면 기존 파일을 삭제하지 않고 기준 변경을 기록한다.

```bash
git add "packages/automation/src/origin-policy.ts" "packages/automation/src/origin-policy.test.ts" "packages/automation/src/recipe-registry.ts"
git commit -m "feat(automation): constrain origins and sealed recipe execution"
```

### Task 5: signed launcher·XPC·단회 요청 채널

**Files:** `platform/macos/operations-helper/Package.swift`, `platform/macos/operations-helper/Sources/Bridge/PeerVerifier.swift`, `platform/macos/operations-helper/Sources/Bridge/Envelope.swift`, `platform/macos/operations-helper/Tests/BridgeTests/PeerTests.swift`, `packages/automation/src/native-channel.ts`, `packages/automation/src/native-channel.test.ts`  
**Interfaces:** `acceptEnvelope(envelope,context): boolean`에서 context는 verifiedPeer,generation,lastSequence,nowMs,permitId이다. native PeerVerifier는 Team ID/bundle requirement/uid/audit-session을 검증한다. JavaScript callback boolean을 native peer 검증의 대체로 쓰지 않는다.

- [ ] **Step 1 — 실패 테스트 작성.** 아래를 해당 `*.test.ts`에 작성한다. test-only fixture를 같은 파일에 두거나 이 Task가 만드는 test-support 파일에서 명시적으로 import한다.

```ts
import { expect, it } from 'vitest';
import { acceptEnvelope } from './native-channel.js';
it('refuses an authenticated but stale/replayed request', () => {
  const c = { verifiedPeer:true,generation:'g2',lastSequence:7,nowMs:10,permitId:'p' };
  const e = { protocolVersion:1,generation:'g1',sequence:8,expiresAtMs:20,permitId:'p' };
  expect(acceptEnvelope(e,c)).toBe(false);
  expect(acceptEnvelope({...e,generation:'g2',sequence:7},c)).toBe(false);
});
```

- [ ] **Step 2 — RED 실행.** `pnpm --filter @gram/automation exec vitest run src/native-channel.test.ts`. 기대: 아래 불변 조건의 assertion이 비구현 export에서 실패. 실패 원인과 로그를 ledger에 남긴다.
- [ ] **Step 3 — 최소 구현.** 다음 계약/순서를 파일에 구현한다. 아래 코드는 계획의 핵심 로직이며 지금 실행된 제품 코드가 아니다.

```ts
// Before parsing a body: bound frame to128KiB; verify protocolVersion1.
// Verify native XPC peer requirement, UID and audit session; challenge nonce.
// Match generation+permit, strict increasing sequence, expiry and intentHash.
// Native launcher accepts a verified sealed release only and starts one fixed
// Node entry with an inherited private pipe; no public arbitrary-exec endpoint.
```

선행 native proof Task다: 설치된 SDK의 peer-code-signing APIs를 compile probe하고 실제 signed test client의 wrong bundle/team/uid/session을 거부한다. `swift test --package-path platform/macos/operations-helper`를 native Mac에서 실행한다. 임시 adhoc fixture는 localtest 증거일 뿐 production Team ID gate를 통과시키지 않는다. 서명된 node로 임의 JS를 실행한 client와 임의 실행자가 띄운 bridge를 거부하는 native case가 없으면 real-credential 활성화 금지다. 원격 privileged helper 설치는 수행하지 않는다.

- [ ] **Step 4 — GREEN·회귀.** `pnpm --filter @gram/automation exec vitest run src/native-channel.test.ts`를 다시 실행하고 관련 패키지 lint/typecheck/build와 루트 테스트를 실행한다. 기대: 새 실패 사례와 기존 테스트 모두 통과. fixture/native/live의 결과는 별도로 기록한다.
- [ ] **Step 5 — 명시적 커밋.** 아래 경로 외 변경은 diff에서 제외 이유를 확인한다. 파일명 충돌이 있으면 기존 파일을 삭제하지 않고 기준 변경을 기록한다.

```bash
git add "platform/macos/operations-helper/Package.swift" "platform/macos/operations-helper/Sources/Bridge/PeerVerifier.swift" "platform/macos/operations-helper/Sources/Bridge/Envelope.swift" "platform/macos/operations-helper/Tests/BridgeTests/PeerTests.swift" "packages/automation/src/native-channel.ts" "packages/automation/src/native-channel.test.ts"
git commit -m "feat(macos): authenticate scoped native helper channels"
```

### Task 6: use-only Keychain·provider vault·비밀정보 차단

**Files:** `packages/credentials/src/credential-use.ts`, `packages/credentials/src/credential-use.test.ts`, `platform/macos/operations-helper/Sources/Credentials/CredentialBroker.swift`, `platform/macos/operations-helper/Tests/CredentialTests/UseOnlyTests.swift`  
**Interfaces:** `credentialUse(request): Promise<AuthResult>`; request에는 intentHash,permitId,credentialRef,recipeId만 존재한다. credential store 원문은 native/private auth worker 경계 밖으로 반환하지 않는다.

- [ ] **Step 1 — 실패 테스트 작성.** 아래를 해당 `*.test.ts`에 작성한다. test-only fixture를 같은 파일에 두거나 이 Task가 만드는 test-support 파일에서 명시적으로 import한다.

```ts
import { expect, it } from 'vitest';
import { credentialRequestKeys, normalizeAuthFailure } from './credential-use.js';
it('has no password-returning request or exception channel', () => {
  expect(credentialRequestKeys()).toEqual(['intentHash','permitId','credentialRef','recipeId']);
  expect(normalizeAuthFailure(new Error('synthetic-secret-value'))).toEqual({status:'REFUSED',code:'AUTH_FAILED'});
});
```

- [ ] **Step 2 — RED 실행.** `pnpm --filter @gram/credentials exec vitest run src/credential-use.test.ts`. 기대: 아래 불변 조건의 assertion이 비구현 export에서 실패. 실패 원인과 로그를 ledger에 남긴다.
- [ ] **Step 3 — 최소 구현.** 다음 계약/순서를 파일에 구현한다. 아래 코드는 계획의 핵심 로직이며 지금 실행된 제품 코드가 아니다.

```ts
export function credentialRequestKeys() { return ['intentHash','permitId','credentialRef','recipeId']; }
export function normalizeAuthFailure(error:unknown) {
  void error; return { status:'REFUSED', code:'AUTH_FAILED' } as const;
}
// Validate permit/origin/recipe before Keychain read; perform use inside broker.
// Disable trace/capture/DOM values before autofill and retain disabling through errors.
// Locked vault or user-presence request => WAITING_USER, not policy downgrade.
```

실제 native temporary keychain fixture로 add/use/remove 및 잠김/권한거부를 검증한다. 사용자 login/System Keychain을 CI에서 수정하지 않는다. secret canary를 stdout/stderr/SQLite/trace/MCP/screenshot 경로 모두에서 검색한다. API refresh single-flight·invalid_grant·password budget·MFA 대기·Aside vault Never 정책을 시험한다. memory zeroization 완전 보장을 주장하지 않는다. broker를 읽기/관리자 계정 암호 추출 도구로 확장하지 않는다.

- [ ] **Step 4 — GREEN·회귀.** `pnpm --filter @gram/credentials exec vitest run src/credential-use.test.ts`를 다시 실행하고 관련 패키지 lint/typecheck/build와 루트 테스트를 실행한다. 기대: 새 실패 사례와 기존 테스트 모두 통과. fixture/native/live의 결과는 별도로 기록한다.
- [ ] **Step 5 — 명시적 커밋.** 아래 경로 외 변경은 diff에서 제외 이유를 확인한다. 파일명 충돌이 있으면 기존 파일을 삭제하지 않고 기준 변경을 기록한다.

```bash
git add "packages/credentials/src/credential-use.ts" "packages/credentials/src/credential-use.test.ts" "platform/macos/operations-helper/Sources/Credentials/CredentialBroker.swift" "platform/macos/operations-helper/Tests/CredentialTests/UseOnlyTests.swift"
git commit -m "feat(credentials): use scoped secrets without returning them"
```

### Task 7: Playwright 전용 profile과 결정적 DOM recipe

**Files:** `packages/automation/src/providers/playwright.ts`, `packages/automation/src/providers/playwright.test.ts`, `packages/automation/src/providers/playwright.integration.test.ts`, `packages/automation/package.json`, `pnpm-lock.yaml`  
**Interfaces:** `PlaywrightProvider`는 descriptor와 OperationAdapter를 구현한다. `profileKey(scope,provider)`는 registry ID의 stable hash, `profilePath`는 고정 user-owned base 아래에서만 계산한다. persistent profile은 동시 owner 하나다.

- [ ] **Step 1 — 실패 테스트 작성.** 아래를 해당 `*.test.ts`에 작성한다. test-only fixture를 같은 파일에 두거나 이 Task가 만드는 test-support 파일에서 명시적으로 import한다.

```ts
import { expect, it } from 'vitest';
import { profileKey } from './playwright.js';
it('never shares a profile across providers or accounts', () => {
  const s = { serviceId:'f',accountId:'a',storeId:'s',resourceType:'catalog' as const,resourceId:'p' };
  expect(profileKey(s,'playwright')).not.toBe(profileKey(s,'aside'));
  expect(profileKey(s,'playwright')).not.toBe(profileKey({...s,accountId:'b'},'playwright'));
});
```

- [ ] **Step 2 — RED 실행.** `pnpm --filter @gram/automation exec vitest run src/providers/playwright.test.ts src/providers/playwright.integration.test.ts`. 기대: 아래 불변 조건의 assertion이 비구현 export에서 실패. 실패 원인과 로그를 ledger에 남긴다.
- [ ] **Step 3 — 최소 구현.** 다음 계약/순서를 파일에 구현한다. 아래 코드는 계획의 핵심 로직이며 지금 실행된 제품 코드가 아니다.

```ts
// profile key binds provider/service/account/store; product IDs do not create
// separate logins. Native generation lock prevents concurrent profile owners.
// Launch a dedicated persistent context with the pinned browser revision.
// Resolve only sealed recipe locators, assert unique element and account state.
// Context close during a mutation returns UNKNOWN; read-only fixtures never save.
```

Task 시작 시 호환 Playwright 버전·browser revision을 공식 문서/실행 probe로 선택해 정확히 고정하고 floating latest를 쓰지 않는다. 실제 Chromium fixture에서 persistent login restart, 만료, wrong account, popup/frame redirect, unique locator, autosave read-only 차단, 프로필 경합, cancel 후 중복전송0을 실행한다. browser 다운로드/실행은 비관리자 테스트 환경에서만 한다. raw cookies/storageState export, sandbox off, 원격 CDP 공개를 추가하지 않는다.

- [ ] **Step 4 — GREEN·회귀.** `pnpm --filter @gram/automation exec vitest run src/providers/playwright.test.ts src/providers/playwright.integration.test.ts`를 다시 실행하고 관련 패키지 lint/typecheck/build와 루트 테스트를 실행한다. 기대: 새 실패 사례와 기존 테스트 모두 통과. fixture/native/live의 결과는 별도로 기록한다.
- [ ] **Step 5 — 명시적 커밋.** 아래 경로 외 변경은 diff에서 제외 이유를 확인한다. 파일명 충돌이 있으면 기존 파일을 삭제하지 않고 기준 변경을 기록한다.

```bash
git add "packages/automation/src/providers/playwright.ts" "packages/automation/src/providers/playwright.test.ts" "packages/automation/src/providers/playwright.integration.test.ts" "packages/automation/package.json" "pnpm-lock.yaml"
git commit -m "feat(automation): run pinned browser recipes in dedicated profiles"
```

### Task 8: Aside 실제 버전·MCP schema binding

**Files:** `packages/automation/src/providers/aside.ts`, `packages/automation/src/providers/aside.test.ts`, `packages/automation/src/providers/aside.native.test.ts`, `docs/operations/aside-binding.md`  
**Interfaces:** `validateAsideBinding(discovered,reviewedDigest): ProviderDescriptor|null`; `AsideProvider`는 검증된 고정 MCP/REPL binding으로만 OperationAdapter를 구현한다. 실제 tool 이름은 discovery 결과를 검토하여 manifest에 기록한다.

- [ ] **Step 1 — 실패 테스트 작성.** 아래를 해당 `*.test.ts`에 작성한다. test-only fixture를 같은 파일에 두거나 이 Task가 만드는 test-support 파일에서 명시적으로 import한다.

```ts
import { expect, it } from 'vitest';
import { acceptsBindingDigest } from './aside.js';
it('refuses a changed tool schema instead of guessing a method', () => {
  expect(acceptsBindingDigest('a'.repeat(64),'b'.repeat(64))).toBe(false);
  expect(acceptsBindingDigest('a'.repeat(64),'a'.repeat(64))).toBe(true);
});
```

- [ ] **Step 2 — RED 실행.** `pnpm --filter @gram/automation exec vitest run src/providers/aside.test.ts`. 기대: 아래 불변 조건의 assertion이 비구현 export에서 실패. 실패 원인과 로그를 ledger에 남긴다.
- [ ] **Step 3 — 최소 구현.** 다음 계약/순서를 파일에 구현한다. 아래 코드는 계획의 핵심 로직이며 지금 실행된 제품 코드가 아니다.

```ts
export function acceptsBindingDigest(observed:string, reviewed:string): boolean {
  return /^[a-f0-9]{64}$/.test(observed) && observed === reviewed;
}
// Discover the installed trusted aside mcp tools and schemas; bound output/time.
// Review immutable binding against fixture recipe, cancellation and origin policy.
// Never turn a model-supplied JS/command string into aside repl input.
// Missing deterministic method => capability unavailable; no guessed API.
```

Aside 네이티브 테스트는 실제 설치된 버전이 있는 명시적 테스트 환경에서만 실행한다. CI에 없으면 NOT_RUN이지 성공이 아니다. account selection, provider vault 잠김/거부, session restart, DOM 출력 redaction, cancellation 불명확 결과, schema 변경 거부를 실제 fixture로 증명한다. 지원되지 않는 network/origin 통제가 필요한 credential 작업은 fallback 또는 wait이며 policy를 낮추지 않는다. 별도 paid AI 모델 작업은 시작하지 않는다.

- [ ] **Step 4 — GREEN·회귀.** `pnpm --filter @gram/automation exec vitest run src/providers/aside.test.ts`를 다시 실행하고 관련 패키지 lint/typecheck/build와 루트 테스트를 실행한다. 기대: 새 실패 사례와 기존 테스트 모두 통과. fixture/native/live의 결과는 별도로 기록한다.
- [ ] **Step 5 — 명시적 커밋.** 아래 경로 외 변경은 diff에서 제외 이유를 확인한다. 파일명 충돌이 있으면 기존 파일을 삭제하지 않고 기준 변경을 기록한다.

```bash
git add "packages/automation/src/providers/aside.ts" "packages/automation/src/providers/aside.test.ts" "packages/automation/src/providers/aside.native.test.ts" "docs/operations/aside-binding.md"
git commit -m "feat(automation): bind Aside capabilities to reviewed local schemas"
```

### Task 9: Mac GUI·TCC·window 세대·긴급 중단

**Files:** `platform/macos/operations-helper/Sources/GUI/WindowActions.swift`, `platform/macos/operations-helper/Tests/GUITests/WindowTests.swift`, `packages/automation/src/providers/native.ts`, `packages/automation/src/providers/native.test.ts`  
**Interfaces:** `canActOnWindow(request,observed): boolean`은 app/window/generation/sessionLock/TCC를 확인한다. native action enum은 observe/activate/type/selectArtifact/revealArtifact/stop이다.

- [ ] **Step 1 — 실패 테스트 작성.** 아래를 해당 `*.test.ts`에 작성한다. test-only fixture를 같은 파일에 두거나 이 Task가 만드는 test-support 파일에서 명시적으로 import한다.

```ts
import { expect, it } from 'vitest';
import { canActOnWindow } from './native.js';
it('refuses a stale or locked window instead of clicking coordinates', () => {
  const r = { appId:'fixture.app',windowId:'1',generation:'g1' };
  expect(canActOnWindow(r,{...r,generation:'g2',locked:false,permission:true})).toBe(false);
  expect(canActOnWindow(r,{...r,locked:true,permission:true})).toBe(false);
});
```

- [ ] **Step 2 — RED 실행.** `pnpm --filter @gram/automation exec vitest run src/providers/native.test.ts`. 기대: 아래 불변 조건의 assertion이 비구현 export에서 실패. 실패 원인과 로그를 ledger에 남긴다.
- [ ] **Step 3 — 최소 구현.** 다음 계약/순서를 파일에 구현한다. 아래 코드는 계획의 핵심 로직이며 지금 실행된 제품 코드가 아니다.

```ts
// Native side verifies current audit-session/window/app and TCC before action.
// Resolve recorded AX element uniquely; no arbitrary screen coordinate endpoint.
// Stop revokes generation permits before closing contexts; notify effect UNKNOWN.
// Capture only approved work window; block credential dialogs and uncertain masks.
```

native test app를 만들어 window replacement, missing TCC, locked/no session, foreign app, password dialog, clipboard isolation을 검증한다. user TCC 권한 클릭을 자동 승인하지 않는다. generated fixture에만 타이핑하고 실제 Finder/설정/개인앱에 실행하지 않는다. GUI 전체 세션 자원은 단일 lease이며 사람 입력 감지 시 pause한다.

- [ ] **Step 4 — GREEN·회귀.** `pnpm --filter @gram/automation exec vitest run src/providers/native.test.ts`를 다시 실행하고 관련 패키지 lint/typecheck/build와 루트 테스트를 실행한다. 기대: 새 실패 사례와 기존 테스트 모두 통과. fixture/native/live의 결과는 별도로 기록한다.
- [ ] **Step 5 — 명시적 커밋.** 아래 경로 외 변경은 diff에서 제외 이유를 확인한다. 파일명 충돌이 있으면 기존 파일을 삭제하지 않고 기준 변경을 기록한다.

```bash
git add "platform/macos/operations-helper/Sources/GUI/WindowActions.swift" "platform/macos/operations-helper/Tests/GUITests/WindowTests.swift" "packages/automation/src/providers/native.ts" "packages/automation/src/providers/native.test.ts"
git commit -m "feat(macos): scope native app actions to verified windows and user sessions"
```

### Task 10: 파일 전달·출력 제한·reconciliation

**Files:** `packages/automation/src/transfer.ts`, `packages/automation/src/transfer.test.ts`, `packages/automation/src/output-sanitizer.ts`, `packages/automation/src/output-sanitizer.test.ts`  
**Interfaces:** `validateTransfer(bytes,totalBytes): boolean`, `sanitizeObservation(raw,allowedFields): object`; MAC03 ArtifactStore의 authorized descriptors로 업/다운로드한다. arbitrary path/secret은 wire에 넣지 않는다.

- [ ] **Step 1 — 실패 테스트 작성.** 아래를 해당 `*.test.ts`에 작성한다. test-only fixture를 같은 파일에 두거나 이 Task가 만드는 test-support 파일에서 명시적으로 import한다.

```ts
import { expect, it } from 'vitest';
import { validateTransfer } from './transfer.js';
it('enforces per-file and per-task limits before a transfer', () => {
  expect(validateTransfer(20*1024*1024+1,0)).toBe(false);
  expect(validateTransfer(10,100*1024*1024)).toBe(false);
  expect(validateTransfer(1024,0)).toBe(true);
});
```

- [ ] **Step 2 — RED 실행.** `pnpm --filter @gram/automation exec vitest run src/transfer.test.ts src/output-sanitizer.test.ts`. 기대: 아래 불변 조건의 assertion이 비구현 export에서 실패. 실패 원인과 로그를 ledger에 남긴다.
- [ ] **Step 3 — 최소 구현.** 다음 계약/순서를 파일에 구현한다. 아래 코드는 계획의 핵심 로직이며 지금 실행된 제품 코드가 아니다.

```ts
export function validateTransfer(bytes:number,totalBytes:number): boolean {
  return Number.isSafeInteger(bytes) && Number.isSafeInteger(totalBytes)
    && bytes>=0 && totalBytes>=0 && bytes<=20971520 && bytes+totalBytes<=104857600;
}
// Stream into exclusive staging, enforce byte count during reads, verify MIME/hash,
// then ArtifactStore commits. Abort never deletes original/provider files.
// Sanitizer constructs allowed fields anew; never logs rejected original payload.
```

잘못된 Content-Length/chunked 초과, symlink 교체, 파일명 traversal, auth header 포함 오류, password text screenshot, 사용자 콘텐츠의 정책변경 지시를 시험한다. 업로드 timeout은 remote 미적용이 아니라 UNKNOWN이다. read-only reconcile은 operationHash/account 범위와 remote identity를 확인한다. 로그 regex만으로 secret-safe 증거를 대체하지 않는다.

- [ ] **Step 4 — GREEN·회귀.** `pnpm --filter @gram/automation exec vitest run src/transfer.test.ts src/output-sanitizer.test.ts`를 다시 실행하고 관련 패키지 lint/typecheck/build와 루트 테스트를 실행한다. 기대: 새 실패 사례와 기존 테스트 모두 통과. fixture/native/live의 결과는 별도로 기록한다.
- [ ] **Step 5 — 명시적 커밋.** 아래 경로 외 변경은 diff에서 제외 이유를 확인한다. 파일명 충돌이 있으면 기존 파일을 삭제하지 않고 기준 변경을 기록한다.

```bash
git add "packages/automation/src/transfer.ts" "packages/automation/src/transfer.test.ts" "packages/automation/src/output-sanitizer.ts" "packages/automation/src/output-sanitizer.test.ts"
git commit -m "feat(automation): constrain transfers and sanitize provider evidence"
```

### Task 11: 실행 프로필·통합·업그레이드·native 인수

**Files:** `apps/agent/src/automation-composition.ts`, `apps/agent/src/automation-composition.test.ts`, `platform/macos/operations-helper/Resources/helper-manifest.json`, `docs/operations/macos-browser-credentials.md`  
**Interfaces:** `allowedRuntimeTools(profile): readonly string[]`; manifest는 signed release identity/정확한 helper bundle/API schema/binding digest만 보유한다. signing identity 누락은 deployment unavailable이다.

- [ ] **Step 1 — 실패 테스트 작성.** 아래를 해당 `*.test.ts`에 작성한다. test-only fixture를 같은 파일에 두거나 이 Task가 만드는 test-support 파일에서 명시적으로 import한다.

```ts
import { expect, it } from 'vitest';
import { allowedRuntimeTools } from './automation-composition.js';
it('does not co-load arbitrary code execution with live credentials', () => {
  const tools = allowedRuntimeTools('OPERATIONS_CREDENTIALLED');
  expect(tools).not.toContain('shell_exec');
  expect(tools).not.toContain('secret_get');
  expect(allowedRuntimeTools('LAB_ONLY')).toEqual(['agent_health']);
});
```

- [ ] **Step 2 — RED 실행.** `pnpm --filter @gram/agent exec vitest run src/automation-composition.test.ts`. 기대: 아래 불변 조건의 assertion이 비구현 export에서 실패. 실패 원인과 로그를 ledger에 남긴다.
- [ ] **Step 3 — 최소 구현.** 다음 계약/순서를 파일에 구현한다. 아래 코드는 계획의 핵심 로직이며 지금 실행된 제품 코드가 아니다.

```ts
// Compose only explicitly registered operation recipes and use-only brokers.
// LAB_ONLY remains separate health-only release; never expand it in place.
// Verify manifest/signature/generation before helper activation; unknown => refuse.
// On upgrade invalidate session observations, permits and provider bindings;
// recover durable tasks/effects through MAC03 before accepting new actions.
```

실행 시 실제 apps/agent package name을 package.json으로 확인한다(스크립트의 @gram/agent는 해당 이름과 다르면 경로 실행으로 기록). integration matrix: API fallback selection, Aside→Playwright 재인증, browser crash after write, no GUI login, vault lock, mismatched helper signature, stale permit, emergency stop, no credentials when coding loaded. 실제 프로세스 격리/native XPC/Keychain·TCC 검증 결과와 B01–B10 mapping을 보고한다. self-review와 independent review를 구분하고 자동 설치/merge하지 않는다.

- [ ] **Step 4 — GREEN·회귀.** `pnpm --filter @gram/agent exec vitest run src/automation-composition.test.ts`를 다시 실행하고 관련 패키지 lint/typecheck/build와 루트 테스트를 실행한다. 기대: 새 실패 사례와 기존 테스트 모두 통과. fixture/native/live의 결과는 별도로 기록한다.
- [ ] **Step 5 — 명시적 커밋.** 아래 경로 외 변경은 diff에서 제외 이유를 확인한다. 파일명 충돌이 있으면 기존 파일을 삭제하지 않고 기준 변경을 기록한다.

```bash
git add "apps/agent/src/automation-composition.ts" "apps/agent/src/automation-composition.test.ts" "platform/macos/operations-helper/Resources/helper-manifest.json" "docs/operations/macos-browser-credentials.md"
git commit -m "feat(agent): gate operations automation on native trust and isolation"
```

## 의존성과 실제 환경 인수

Task 1→2→3→4는 fixture에서 검증할 수 있다. Task 5는 native 채널의 prerequisite이며 Task 6·9가 이를 소비한다. Task 7·8은 독립 provider로 시험할 수 있으나 실제 credential은 Task 5·6·11 gate 통과 후만 사용한다. Task 10은 MAC-03 ArtifactStore를 소비한다. Task 11이 모든 결과를 조립한다. selector/API 미확인을 추측으로 채우지 말고 설치 schema/fixture probe 결과로 binding을 작성한다.

최종 보고는 B01–B10별 commit/테스트/provider version/OS/signing context를 기록한다. Provider가 설치되지 않았거나 실제 계정이 등록되지 않은 경우 해당 capability는 NOT_RUN/UNAVAILABLE이다. 이러한 상태는 지원 경로의 fixture 구현을 막는 이유가 아니라 live 동작을 차단하는 명확한 gate다.
