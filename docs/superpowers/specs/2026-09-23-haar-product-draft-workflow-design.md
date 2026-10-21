# MAC-05 HAAR 상품 초안·검수 워크플로 — 상세 설계

**상태:** DRAFT / REVIEW_REQUIRED / NOT_IMPLEMENTED  
**작성:** 2026-09-23 (Asia/Seoul)  
**범위:** 사용자가 요청한 상세 설계·실행계획 패키지. 실행·설치·계정 접근·병합 승인이 아니다.  
**대응 계획:** `docs/superpowers/plans/2026-09-23-haar-product-draft-workflow.md`  
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

## 1. 첫 실제 업무의 목표

`haar.product-draft.v1`은 **상품 하나의 검증된 정보·승인된 기존 이미지로 로컬 상세정보 초안과 검수 패키지를 만들고 실제 게시 전에 끝내는 recipe**다. HAAR 전체 운영을 코딩으로 축소하지 않되, 결제·주문·광고·CS까지 첫 완료 조건에 섞지 않는다.

선택은 local-first draft다. 바로 실스토어에 게시하는 방식은 검수·롤백 위험이 크고, 원격 관리자 페이지의 임시저장도 autosave/외부 mutation일 수 있다. 따라서 MAC-05 v1에는 원격 draft 저장·이미지 업로드·게시 버튼 호출 자체를 넣지 않는다. 이후 live publish는 별도 recipe/operationHash 승인으로 추가해야 한다.

`ExecutionMode`는 MAC-03 계약을 쓰되 이 recipe는 FIXTURE와 READ_ONLY만 허용한다. READ_ONLY는 외부 서비스 변경 금지이며 작업 범위 로컬 artifact 생성은 허용한다. WRITE_APPROVED를 넣어 이 recipe의 범위를 넓힐 수 없다.

## 2. 자료 출처와 live provider 등록

기본 인수시험은 `haar-fixture` 서비스의 합성 상품 `fixture-product-001`이다. 실제 HAAR 제품의 소재·가격·치수·이미지 사용권을 추정하지 않는다. 실제 provider/계정/스토어는 아직 선택·등록되지 않았으며 G05-SOURCE에서 확인한다.

입력 소스는 두 종류다.
- `PROVIDER_READ`: MAC-04의 검증된 read adapter가 확인한 account/store/product와 version/content digest.
- `MANUAL_IMPORT`: 사용자가 제공한 구조화 상품 JSON·이미지 파일. 계정 로그인 확인을 했다고 표시하지 않고 import 출처와 제공 시점을 명시한다.

기존 ChatGPT Drive/쇼핑몰 connector는 현재 대화에서만 쓸 수 있는 수단인지, 로컬 runtime에서도 호출 가능한 API인지 구분한다. 로컬 adapter가 없으면 connector 토큰이 자동 전달된다고 가정하지 않는다. 실제 계정은 read-only 권한으로 onboarding하며 영구 저장될 비밀정보는 MAC-04 use-only 경계 밖으로 나오지 않는다.

## 3. 입력·출력 계약

MAC-03의 Scope와 ArtifactRef를 그대로 사용한다. 새로운 계약은 다음과 같다.

```ts
export interface Fact<T> { value: T; sourceRef: string; sourceDigest: string }
export interface ProductSnapshot {
  schemaVersion: 1; scope: Scope; productId: string;
  version: string | null; contentDigest: string; sourceKind: 'PROVIDER_READ' | 'MANUAL_IMPORT';
  title: Fact<string>; description: Fact<string> | null;
  attributes: Readonly<Record<string, Fact<string>>>;
  variants: readonly { id: string; label: Fact<string>; price: Fact<string> | null; currency: string | null }[];
  observedAt: string;
}
export interface ApprovedAsset {
  artifact: ArtifactRef; productId: string; variantId: string | null;
  role: 'HERO' | 'DETAIL' | 'WEAR'; approvalRef: string;
  sourceRef: string; sourceDigest: string;
}
export interface ProductDraftInput {
  schemaVersion: 1; source: ArtifactRef; productId: string;
  assets: readonly ApprovedAsset[]; copy: ArtifactRef | null;
  templateVersion: 1; outputLocale: 'ko-KR';
}
export interface DraftBundle {
  schemaVersion: 1; taskId: string; revision: number;
  inputDigest: string; recipeDigest: string; productId: string;
  state: 'REVIEW_READY' | 'NEEDS_INPUT' | 'STALE_INPUT';
  artifacts: readonly ArtifactRef[]; issues: readonly string[];
  publication: 'NOT_REQUESTED'; remoteMutationCount: 0;
}
```

Fact는 외부 문장에 존재한다는 이유만으로 사실 확정이 아니다. 제공자가 승인한 데이터/원본을 sourceRef로 연결한다. 동일 필드의 서로 다른 값은 `SOURCE_CONFLICT`로 기록하고 임의 선택하지 않는다. 실제 domain product ID를 소문자 변환하지 않는다.

기본 title 1–200자, description 최대 20,000자, attributes 최대 100개, variants 최대 100개다. 통화/가격은 원문 값을 보존하고 환율·할인·원가를 자동 추론하지 않는다. schema 밖 필드·HTML script·고객 개인정보는 입력 단계에서 거부/격리한다. 미확인 소재·원산지·인증·알레르기·변색·도금·치수·중량은 생성하지 않는다.

## 4. 모듈과 데이터 흐름

새 `packages/haar-workflows/`가 recipe와 domain validation만 담당한다. 원격 로그인·브라우저 조작은 MAC-04에 위임하고 DB 상태/lease/중복효과/아티팩트 저장은 MAC-03을 사용한다.

```text
validated input / authorized source
 -> catalog.read or MANUAL_IMPORT
 -> source snapshot + product/variant identity
 -> approved asset checks
 -> deterministic copy mapping / supplied reviewed copy
 -> draft JSON + scriptless HTML + review issues
 -> source version/content recheck
 -> atomic local bundle commit
 -> root task COMPLETED, output REVIEW_READY
```

각 단계는 고정 stepKey `source`, `assets`, `copy`, `render`, `recheck`, `bundle`를 사용한다. 재시작 시 input/recipe digest가 일치하는 확정 step만 재사용한다. 바뀐 입력은 새 revision을 요구하고 이미 검수된 bundle을 덮어쓰지 않는다. MAC03 root task 완료는 ‘초안 준비 완료’이며 상품 게시 완료가 아니다.

필수 자료 부족은 output NEEDS_INPUT와 `WAITING_USER/HUMAN_DECISION`, source drift는 STALE_INPUT와 재확인 대기로 기록한다. 인증 문제는 MAC-04의 WAITING_USER/AUTH_CHALLENGE 또는 VAULT_LOCKED이고 자료 부족과 구분한다.

## 5. 상품·옵션·이미지 충실도

상품/variant ID가 일치하는 이미지와 사용 승인 참조만 수용한다. HERO 최소 1개, 총 1–10개, 동일 파일 해시는 중복 제거한다. PNG/JPEG/WebP만 허용하고 magic/MIME/실제 decoder 결과를 대조한다. 최대 20MiB/file, 100MiB/task, 40 megapixels/image다. SVG, 실행파일, archive, 잘못된 크기 메타데이터는 거부한다. 이 수치는 운영 limit 제안이며 판매 플랫폼 limit라고 주장하지 않는다.

첫 recipe는 제품 이미지의 누끼·형태·무늬·색상·주름·사이즈를 재생성하지 않는다. 승인된 원본 byte를 보존하고 표시 순서·alt text·레이아웃만 구성한다. 별도 생성 서비스 이용/유료 작업/새 모델 합성은 추가 승인이 있는 후속 recipe다. 레퍼런스 사진을 실구매 후기라고 게시하거나 가짜 고객 경험을 만들지 않는다.

읽기 어려운 제품 옵션이나 승인 누락은 사람에게 자료를 요청하고 멈춘다. 파일명이나 이전 대화만으로 작은호피/큰호피, 실버/골드 같은 옵션을 결정하지 않는다. sourceRef와 variant 연결을 검수표에 표시한다.

## 6. 카피·HTML·검수

추론 비용이 없는 기본 경로는 제공된 Fact와 승인된 copy artifact를 deterministic template에 매핑한다. 신규 표현을 모델이 제안하는 경우 active ChatGPT가 전달한 별도 copy artifact를 받고, 제안/승인 상태와 출처를 남긴다. 대화가 끊기면 새 카피를 계속 생성하는 local LLM/API가 있다고 가정하지 않는다.

출력은 `product-source.json`, `asset-manifest.json`, `draft.json`, `preview.html`, `review.md`, `bundle.json`이다. 실제 파일명은 task/revision의 고정 상대 이름으로 생성하고 외부 파일명을 실행/경로로 쓰지 않는다. bundle.json은 나머지 결과의 hash를 담고 자기 hash를 내부에 넣지 않는다. DB ArtifactRef가 bundle 자체 digest를 보유한다.

HTML은 모든 사용자 필드를 escape하고 JavaScript/form/iframe/remote font/remote image/외부 URL 로딩을 포함하지 않는다. CSP는 default-src 'none', img-src 'self' data:, style-src 'unsafe-inline'이다. inline style만 고정 template에서 나오며 사용자 CSS는 받지 않는다. 이미지는 bundle 안의 generated 상대 경로로 표시한다. 검수표에는 사용 사실, 누락/충돌, source digests, 승인 asset, 미게시 상태가 있다.

## 7. 버전 재확인·재시작·원자 출력

PROVIDER_READ는 시작과 끝에 같은 product/account/store의 version을 대조한다. provider가 버전을 제공하지 않으면 정규화한 승인 필드의 contentDigest를 비교한다. 비교 가능한 snapshot을 얻지 못하면 STALE_INPUT/WAITING_DEPENDENCY이며 READY로 마무리하지 않는다. 이 read-only 검증이 서버의 동시성 lock이나 게시 허가를 뜻하지 않는다.

MANUAL_IMPORT는 원본 ArtifactRef digest와 승인 기록을 다시 확인하고 live freshness를 UNKNOWN으로 표시한다. 이를 이유로 지원하지 않는 live API를 호출하지 않는다.

로컬 생성은 `(taskId, revision, inputDigest, recipeDigest)`로 idempotent하다. 전용 staging 디렉터리에 전체 산출물을 쓰고 해시·manifest를 확인한 뒤 atomic rename하고 DB 등록한다. 기존 destination이 같으면 검증 후 재사용, 다르면 `OUTPUT_CONFLICT`; 삭제/덮어쓰기 금지다. 파일 publish 뒤 DB commit 전 crash는 orphan manifest를 대조해 재연결하고 원본을 다시 전송하지 않는다. partial staging은 최종 산출물로 표시하지 않는다.

## 8. 인수시험과 실제 서비스 확대 조건

| ID | 필수 결과 | 계획 Task |
|---|---|---|
| H01 | strict 상품/옵션/출처 입력, FACT 누락/충돌 중단 | 1,2 |
| H02 | 승인 asset·제품 ID 일치·형태 변경 없음·크기 제한 | 3 |
| H03 | 사실 기반 카피, scriptless 안전 HTML | 4 |
| H04 | 여섯 step checkpoint·재부팅 재개·새 입력 revision | 5 |
| H05 | source drift 중단, atomic bundle/중복 방지 | 6 |
| H06 | 실제 계정 read-only onboarding, 원격 mutation 0 | 7 |
| H07 | 미게시 REVIEW_READY 표시·전 과정 증거와 회귀 | 8 |

fixture end-to-end는 계정 없이 독립 실행한다. Playwright/Aside/native 테스트는 동일 recipe의 adapter별 evidence이고 서로 성공을 대신하지 않는다. 실제 HAAR acceptance는 사용자가 고른 한 상품과 승인된 이미지로 진행하며 임시 계정/자료와 실제 계정을 섞지 않는다.

MAC-05 완료가 상품 등록·재고 변경·광고·결제·CS 자동화를 모두 제공한다는 뜻은 아니다. 해당 업무는 MAC-03/04 기반에 추가 recipe와 구체적 승인 임계값을 설계한 뒤 확장한다. 이번 package에는 그 범위의 구현 완료를 표시하지 않는다.
