#!/usr/bin/env bash
set -euo pipefail

PROJECT_TITLE='Gram Coding Agent — Engineering'
API_VERSION='2026-03-10'
BACKLOG_FILE="${BACKLOG_FILE:-scripts/github-backlog.json}"
MODE="${1:---bootstrap}"

log() { printf '[github-backlog] %s\n' "$*" >&2; }
die() { printf '[github-backlog] ERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"; }

case "$MODE" in
  --bootstrap|--sync-status) ;;
  *) die "unsupported mode: $MODE (expected --bootstrap or --sync-status)" ;;
esac

need gh
need jq
need python3

gh auth status >/dev/null 2>&1 || die 'GitHub CLI is not authenticated'

REPO="${GH_REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
OWNER="${REPO%%/*}"
REPO_NAME="${REPO#*/}"
[[ -n "$OWNER" && -n "$REPO_NAME" && "$OWNER" != "$REPO_NAME" ]] || die "invalid repository: $REPO"
[[ -f "$BACKLOG_FILE" ]] || die "approved backlog manifest not found: $BACKLOG_FILE"

python3 - "$BACKLOG_FILE" <<'PY'
import json, sys
from pathlib import Path
path = Path(sys.argv[1])
data = json.loads(path.read_text())
if data.get('version') != 1:
    raise SystemExit('backlog manifest version must be 1')
issues = data.get('issues')
if not isinstance(issues, list) or len(issues) != 130:
    raise SystemExit('backlog manifest must contain exactly 130 issues')
numbers = [item.get('number') for item in issues]
if numbers != list(range(1, 131)):
    raise SystemExit('backlog manifest issue numbers must be contiguous #1-#130')
titles = [item.get('title') for item in issues]
if any(not isinstance(title, str) or not title.strip() for title in titles):
    raise SystemExit('every backlog issue requires a non-empty title')
if len(set(titles)) != len(titles):
    raise SystemExit('backlog issue titles must be unique')
if any(not isinstance(item.get('body'), str) for item in issues):
    raise SystemExit('every backlog issue requires a string body')
PY

declare -A ACTUAL_NUMBER
declare -A ACTUAL_URL

manifest_issue_json() {
  local logical="$1"
  jq -c --argjson n "$logical" '.issues[] | select(.number == $n)' "$BACKLOG_FILE"
}

materialize_issues() {
  local existing logical item title body matches count url actual
  existing="$(gh issue list --repo "$REPO" --state all --limit 500 --json number,title,body,url)"

  for logical in $(seq 1 130); do
    item="$(manifest_issue_json "$logical")"
    [[ -n "$item" ]] || die "manifest entry #$logical missing"
    title="$(jq -r .title <<<"$item")"
    body="$(jq -r .body <<<"$item")"
    matches="$(jq -c --arg title "$title" '[.[] | select(.title == $title)]' <<<"$existing")"
    count="$(jq 'length' <<<"$matches")"

    if [[ "$count" == '0' ]]; then
      url="$(gh issue create --repo "$REPO" --title "$title" --body "$body")"
      actual="${url##*/}"
      [[ "$actual" =~ ^[0-9]+$ ]] || die "could not determine created issue number for: $title"
      existing="$(jq -c --argjson number "$actual" --arg title "$title" --arg body "$body" --arg url "$url" \
        '. + [{number:$number,title:$title,body:$body,url:$url}]' <<<"$existing")"
      log "created backlog item $logical as issue #$actual: $title"
    elif [[ "$count" == '1' ]]; then
      actual="$(jq -r '.[0].number' <<<"$matches")"
      url="$(jq -r '.[0].url' <<<"$matches")"
      log "reused backlog item $logical as issue #$actual: $title"
    else
      die "multiple issues have approved backlog title: $title"
    fi

    ACTUAL_NUMBER[$logical]="$actual"
    ACTUAL_URL[$logical]="$url"
  done
}

ensure_label() {
  local name="$1" color="$2" description="$3"
  gh label create "$name" --repo "$REPO" --color "$color" --description "$description" --force >/dev/null
}

ensure_milestone() {
  local title="$1"
  local number
  number="$(gh api -H "X-GitHub-Api-Version: $API_VERSION" "repos/$REPO/milestones?state=all&per_page=100" \
    --jq ".[] | select(.title == \"$title\") | .number" | head -n1)"
  if [[ -z "$number" ]]; then
    number="$(gh api -X POST -H "X-GitHub-Api-Version: $API_VERSION" "repos/$REPO/milestones" -f title="$title" --jq .number)"
  fi
  printf '%s\n' "$number"
}

ensure_project() {
  local number output
  if ! gh project list --owner "$OWNER" --format json --limit 1 >/dev/null 2>&1; then
    die "GitHub CLI token cannot access Projects; run: gh auth refresh -s project"
  fi
  number="$(gh project list --owner "$OWNER" --format json --jq ".projects[] | select(.title == \"$PROJECT_TITLE\") | .number" | head -n1)"
  if [[ -z "$number" ]]; then
    if ! number="$(gh project create --owner "$OWNER" --title "$PROJECT_TITLE" --format json --jq .number)"; then
      die "failed to create GitHub Project; authenticate gh with Projects write access"
    fi
  fi
  [[ "$number" =~ ^[0-9]+$ ]] || die "invalid project number for $PROJECT_TITLE: $number"
  gh project edit "$number" --owner "$OWNER" --visibility PRIVATE >/dev/null
  if ! output="$(gh project link "$number" --owner "$OWNER" --repo "$REPO_NAME" 2>&1)"; then
    grep -qiE 'already|exists|linked' <<<"$output" || die "failed to link project: $output"
  fi
  printf '%s\n' "$number"
}

field_json() {
  local project_number="$1" field_name="$2"
  gh project field-list "$project_number" --owner "$OWNER" --format json --limit 100 \
    --jq ".fields[] | select(.name == \"$field_name\")"
}

ensure_single_select_field() {
  local project_number="$1" field_name="$2" options_csv="$3"
  local current
  current="$(field_json "$project_number" "$field_name")"
  if [[ -z "$current" ]]; then
    gh project field-create "$project_number" --owner "$OWNER" --name "$field_name" \
      --data-type SINGLE_SELECT --single-select-options "$options_csv" >/dev/null
  fi
}

sync_status_options() {
  local project_number="$1"
  local current field_id options_json query payload
  current="$(field_json "$project_number" 'Status')"
  [[ -n "$current" ]] || die 'GitHub Project built-in Status field not found'
  field_id="$(jq -r .id <<<"$current")"
  options_json="$(python3 - "$current" <<'PY'
import json, sys
field = json.loads(sys.argv[1])
existing = {o['name']: o for o in field.get('options', [])}
colors = {
    'Backlog': 'GRAY', 'Ready': 'BLUE', 'In Progress': 'YELLOW',
    'Blocked': 'RED', 'Review': 'PURPLE', 'Done': 'GREEN',
}
result = []
for name in ['Backlog', 'Ready', 'In Progress', 'Blocked', 'Review', 'Done']:
    item = {'name': name, 'color': colors[name], 'description': f'Gram Coding Agent status: {name}'}
    if name in existing:
        item['id'] = existing[name]['id']
    result.append(item)
print(json.dumps(result, separators=(',', ':')))
PY
)"
  query='mutation($field:ID!,$opts:[ProjectV2SingleSelectFieldOptionInput!]!){updateProjectV2Field(input:{fieldId:$field,singleSelectOptions:$opts}){projectV2Field{... on ProjectV2SingleSelectField{id name}}}}'
  payload="$(jq -nc --arg query "$query" --arg field "$field_id" --argjson opts "$options_json" \
    '{query:$query,variables:{field:$field,opts:$opts}}')"
  gh api graphql --input - <<<"$payload" >/dev/null
}

issue_milestone_title() {
  local logical="$1"
  if (( logical <= 12 )); then printf '%s\n' 'M0 — Architecture & Repository Foundation'
  elif (( logical <= 36 )); then printf '%s\n' 'M1 — Secure Agent Runtime'
  elif (( logical <= 77 )); then printf '%s\n' 'M2 — First End-to-End Coding Task'
  elif (( logical <= 97 )); then printf '%s\n' 'M3 — Reliability & Recovery'
  elif (( logical <= 112 )); then printf '%s\n' 'M4 — Windows Integration & Developer UX'
  else printf '%s\n' 'M5 — Hardening & Production Readiness'
  fi
}

extract_meta() {
  python3 - "$1" <<'PY'
import re, sys
body = sys.argv[1]
m = re.search(r'Target metadata:\s*Priority=(P[0-3]),\s*Area=([^,]+),\s*Risk=([^,]+),\s*Milestone=(M[0-5]),\s*Size=(XS|S|M|L|XL)', body)
if not m:
    m = re.search(r'Target(?: metadata)?:\s*(P[0-3])\s*/\s*([^/]+?)\s*/\s*([^/]+?)\s*/\s*(M[0-5])\s*/\s*(XS|S|M|L|XL)', body)
if m:
    print('|'.join(x.strip().rstrip('.') for x in m.groups()))
PY
}

extract_parent() {
  python3 - "$1" <<'PY'
import re, sys
m = re.search(r'\bParent:\s*#(\d+)', sys.argv[1])
print(m.group(1) if m else '')
PY
}

extract_dependencies() {
  python3 - "$1" <<'PY'
import re, sys
body = sys.argv[1].replace('–', '-').replace('—', '-')
m = re.search(r'\bDepends on:\s*([^\n]+)', body)
if not m or m.group(1).strip().lower() == 'none':
    raise SystemExit
text = m.group(1)
out=[]
for a,b in re.findall(r'#(\d+)(?:\s*-\s*#?(\d+))?', text):
    start=int(a); end=int(b) if b else start
    out.extend(range(start,end+1))
print(' '.join(map(str,dict.fromkeys(out))))
PY
}

ensure_sub_issue() {
  local parent="$1" child="$2" child_id
  child_id="$(gh api -H "X-GitHub-Api-Version: $API_VERSION" "repos/$REPO/issues/$child" --jq .id)"
  if ! gh api -H "X-GitHub-Api-Version: $API_VERSION" "repos/$REPO/issues/$parent/sub_issues?per_page=100" \
      --jq ".[] | select(.number == $child) | .number" | grep -qx "$child"; then
    gh api -X POST -H "X-GitHub-Api-Version: $API_VERSION" "repos/$REPO/issues/$parent/sub_issues" \
      -F sub_issue_id="$child_id" >/dev/null
  fi
}

ensure_blocked_by() {
  local issue="$1" blocker="$2" blocker_id
  blocker_id="$(gh api -H "X-GitHub-Api-Version: $API_VERSION" "repos/$REPO/issues/$blocker" --jq .id)"
  if ! gh api -H "X-GitHub-Api-Version: $API_VERSION" "repos/$REPO/issues/$issue/dependencies/blocked_by?per_page=100" \
      --jq ".[] | select(.number == $blocker) | .number" | grep -qx "$blocker"; then
    gh api -X POST -H "X-GitHub-Api-Version: $API_VERSION" "repos/$REPO/issues/$issue/dependencies/blocked_by" \
      -F issue_id="$blocker_id" >/dev/null
  fi
}

project_item_id_for_url() {
  local url="$1"
  jq -r --arg url "$url" '.items[]? | select(.content.url == $url) | .id' <<<"$PROJECT_ITEMS_JSON" | head -n1
}

set_project_field() {
  local item_id="$1" field="$2" value="$3"
  local field_json field_id option_id
  [[ -n "$value" ]] || return 0
  [[ -n "$item_id" ]] || die "missing Project item node ID for field $field"

  field_json="$(jq -c --arg field "$field" '.fields[]? | select(.name == $field)' <<<"$PROJECT_FIELDS_JSON" | head -n1)"
  [[ -n "$field_json" ]] || die "Project field not found: $field"
  field_id="$(jq -r .id <<<"$field_json")"
  option_id="$(jq -r --arg value "$value" '.options[]? | select(.name == $value) | .id' <<<"$field_json" | head -n1)"
  [[ -n "$field_id" && "$field_id" != null ]] || die "Project field node ID missing: $field"
  [[ -n "$option_id" && "$option_id" != null ]] || die "Project option not found: $field=$value"

  gh project item-edit \
    --id "$item_id" \
    --project-id "$PROJECT_ID" \
    --field-id "$field_id" \
    --single-select-option-id "$option_id" >/dev/null
}

project_has_url() {
  local url="$1"
  [[ -n "$(project_item_id_for_url "$url")" ]]
}

ensure_project_item() {
  local project_number="$1" url="$2" item_id
  item_id="$(project_item_id_for_url "$url")"
  if [[ -n "$item_id" ]]; then
    printf 'existing|%s\n' "$item_id"
    return 0
  fi

  gh project item-add "$project_number" --owner "$OWNER" --url "$url" >/dev/null || \
    die "failed to add project item $url"
  item_id="$(gh project item-list "$project_number" --owner "$OWNER" --format json --limit 500 \
    --jq ".items[]? | select(.content.url == \"$url\") | .id" | head -n1)"
  [[ -n "$item_id" ]] || die "could not resolve Project item node ID after adding $url"
  printf 'new|%s\n' "$item_id"
}

sync_issue() {
  local logical="$1" actual item body url title milestone parent_logical parent_actual deps blocker_logical blocker_actual
  local meta priority area risk milestone_code size item_ref item_state item_id
  actual="${ACTUAL_NUMBER[$logical]}"
  item="$(manifest_issue_json "$logical")"
  title="$(jq -r .title <<<"$item")"
  body="$(jq -r .body <<<"$item")"
  url="${ACTUAL_URL[$logical]}"
  milestone="$(issue_milestone_title "$logical")"

  gh issue edit "$actual" --repo "$REPO" --milestone "$milestone" >/dev/null
  item_ref="$(ensure_project_item "$PROJECT_NUMBER" "$url")"
  IFS='|' read -r item_state item_id <<<"$item_ref"
  [[ -n "$item_id" ]] || die "Project item node ID missing for $url"

  if [[ "$logical" =~ ^(1|13|37|78|98|113)$ ]]; then
    gh issue edit "$actual" --repo "$REPO" --add-label 'type:epic' >/dev/null
  elif (( logical >= 7 && logical <= 12 )); then
    gh issue edit "$actual" --repo "$REPO" --add-label 'type:docs' >/dev/null
  fi

  meta="$(extract_meta "$body")"
  if [[ -n "$meta" ]]; then
    IFS='|' read -r priority area risk milestone_code size <<<"$meta"
    set_project_field "$item_id" 'Priority' "$priority"
    set_project_field "$item_id" 'Area' "$area"
    set_project_field "$item_id" 'Risk' "$risk"
    set_project_field "$item_id" 'Size' "$size"
  fi

  if (( logical >= 7 && logical <= 12 )); then
    set_project_field "$item_id" 'Status' 'Done'
    gh issue close "$actual" --repo "$REPO" --reason completed >/dev/null 2>&1 || true
  elif [[ "$item_state" == new ]]; then
    set_project_field "$item_id" 'Status' 'Backlog'
  fi

  parent_logical="$(extract_parent "$body")"
  if [[ -n "$parent_logical" ]]; then
    parent_actual="${ACTUAL_NUMBER[$parent_logical]:-}"
    [[ -n "$parent_actual" ]] || die "unknown parent backlog item #$parent_logical for logical #$logical"
    ensure_sub_issue "$parent_actual" "$actual"
  fi

  deps="$(extract_dependencies "$body")"
  for blocker_logical in $deps; do
    blocker_actual="${ACTUAL_NUMBER[$blocker_logical]:-}"
    [[ -n "$blocker_actual" ]] || die "unknown dependency backlog item #$blocker_logical for logical #$logical"
    ensure_blocked_by "$actual" "$blocker_actual"
  done

  log "synced backlog #$logical -> issue #$actual: $title"
}

log "repository: $REPO"
log "mode: $MODE"
materialize_issues

ensure_label 'type:epic' '5319E7' 'Epic / parent work item'
ensure_label 'type:feature' '1D76DB' 'Feature implementation'
ensure_label 'type:bug' 'D73A4A' 'Bug fix'
ensure_label 'type:test' '0E8A16' 'Test / verification work'
ensure_label 'type:security' 'B60205' 'Security-sensitive work'
ensure_label 'type:docs' '0075CA' 'Documentation work'
ensure_label 'needs:approval' 'FBCA04' 'Requires explicit approval before execution'
ensure_label 'breaking-change' 'D93F0B' 'Breaking behavior or contract change'

M0_NUMBER="$(ensure_milestone 'M0 — Architecture & Repository Foundation')"
M1_NUMBER="$(ensure_milestone 'M1 — Secure Agent Runtime')"
M2_NUMBER="$(ensure_milestone 'M2 — First End-to-End Coding Task')"
M3_NUMBER="$(ensure_milestone 'M3 — Reliability & Recovery')"
M4_NUMBER="$(ensure_milestone 'M4 — Windows Integration & Developer UX')"
M5_NUMBER="$(ensure_milestone 'M5 — Hardening & Production Readiness')"
readonly M0_NUMBER M1_NUMBER M2_NUMBER M3_NUMBER M4_NUMBER M5_NUMBER

PROJECT_NUMBER="$(ensure_project)"
readonly PROJECT_NUMBER
sync_status_options "$PROJECT_NUMBER"
ensure_single_select_field "$PROJECT_NUMBER" 'Priority' 'P0,P1,P2,P3'
ensure_single_select_field "$PROJECT_NUMBER" 'Area' 'Core,MCP,Security,Task,Git,GitHub,Workspace,Verify,Windows,Ops'
ensure_single_select_field "$PROJECT_NUMBER" 'Risk' 'Low,Medium,High,Critical'
ensure_single_select_field "$PROJECT_NUMBER" 'Size' 'XS,S,M,L,XL'

PROJECT_ID="$(gh project view "$PROJECT_NUMBER" --owner "$OWNER" --format json --jq .id)"
[[ -n "$PROJECT_ID" && "$PROJECT_ID" != null ]] || die "Project node ID not found for project #$PROJECT_NUMBER"
readonly PROJECT_ID

PROJECT_FIELDS_JSON="$(gh project field-list "$PROJECT_NUMBER" --owner "$OWNER" --format json --limit 100)"
readonly PROJECT_FIELDS_JSON
PROJECT_ITEMS_JSON="$(gh project item-list "$PROJECT_NUMBER" --owner "$OWNER" --format json --limit 500)"
readonly PROJECT_ITEMS_JSON

for logical in $(seq 1 130); do sync_issue "$logical"; done

log "synchronized manifest-backed issues, labels, M0-M5 repository milestones, project fields/items, sub-issues, dependencies, and design Done state"
