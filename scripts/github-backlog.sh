#!/usr/bin/env bash
set -euo pipefail

PROJECT_TITLE='Gram Coding Agent — Engineering'
API_VERSION='2026-03-10'

log() { printf '[github-backlog] %s\n' "$*" >&2; }
die() { printf '[github-backlog] ERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"; }

need gh
need jq
need python3

gh auth status >/dev/null 2>&1 || die 'GitHub CLI is not authenticated'

REPO="${GH_REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
OWNER="${REPO%%/*}"
REPO_NAME="${REPO#*/}"
[[ -n "$OWNER" && -n "$REPO_NAME" && "$OWNER" != "$REPO_NAME" ]] || die "invalid repository: $REPO"

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
  local number
  number="$(gh project list --owner "$OWNER" --format json --jq ".projects[] | select(.title == \"$PROJECT_TITLE\") | .number" | head -n1)"
  if [[ -z "$number" ]]; then
    number="$(gh project create --owner "$OWNER" --title "$PROJECT_TITLE" --format json --jq .number)"
  fi
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
  local n="$1"
  if (( n <= 12 )); then printf '%s\n' 'M0 — Architecture & Repository Foundation'
  elif (( n <= 36 )); then printf '%s\n' 'M1 — Secure Agent Runtime'
  elif (( n <= 77 )); then printf '%s\n' 'M2 — First End-to-End Coding Task'
  elif (( n <= 97 )); then printf '%s\n' 'M3 — Reliability & Recovery'
  elif (( n <= 112 )); then printf '%s\n' 'M4 — Windows Integration & Developer UX'
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

set_project_field() {
  local project_number="$1" url="$2" field="$3" value="$4"
  [[ -n "$value" ]] || return 0
  gh project item-edit "$project_number" --owner "$OWNER" --url "$url" --field "$field" --value "$value" >/dev/null
}

ensure_project_item() {
  local project_number="$1" url="$2" output
  if ! output="$(gh project item-add "$project_number" --owner "$OWNER" --url "$url" --format json 2>&1)"; then
    grep -qiE 'already|exists|added' <<<"$output" || die "failed to add project item $url: $output"
  fi
}

sync_issue() {
  local n="$1" json title body url milestone parent deps meta priority area risk milestone_code size
  json="$(gh api -H "X-GitHub-Api-Version: $API_VERSION" "repos/$REPO/issues/$n")"
  title="$(jq -r .title <<<"$json")"
  body="$(jq -r '.body // ""' <<<"$json")"
  url="$(jq -r .html_url <<<"$json")"
  milestone="$(issue_milestone_title "$n")"

  gh issue edit "$n" --repo "$REPO" --milestone "$milestone" >/dev/null
  ensure_project_item "$PROJECT_NUMBER" "$url"

  if [[ "$n" =~ ^(1|13|37|78|98|113)$ ]]; then
    gh issue edit "$n" --repo "$REPO" --add-label 'type:epic' >/dev/null
  elif (( n >= 7 && n <= 12 )); then
    gh issue edit "$n" --repo "$REPO" --add-label 'type:docs' >/dev/null
  fi

  meta="$(extract_meta "$body")"
  if [[ -n "$meta" ]]; then
    IFS='|' read -r priority area risk milestone_code size <<<"$meta"
    set_project_field "$PROJECT_NUMBER" "$url" 'Priority' "$priority"
    set_project_field "$PROJECT_NUMBER" "$url" 'Area' "$area"
    set_project_field "$PROJECT_NUMBER" "$url" 'Risk' "$risk"
    set_project_field "$PROJECT_NUMBER" "$url" 'Milestone' "$milestone_code"
    set_project_field "$PROJECT_NUMBER" "$url" 'Size' "$size"
  fi

  if (( n >= 7 && n <= 12 )); then
    set_project_field "$PROJECT_NUMBER" "$url" 'Status' 'Done'
    gh issue close "$n" --repo "$REPO" --reason completed >/dev/null 2>&1 || true
  else
    set_project_field "$PROJECT_NUMBER" "$url" 'Status' 'Backlog'
  fi

  parent="$(extract_parent "$body")"
  [[ -z "$parent" ]] || ensure_sub_issue "$parent" "$n"
  deps="$(extract_dependencies "$body")"
  for blocker in $deps; do ensure_blocked_by "$n" "$blocker"; done

  log "synced #$n $title"
}

log "repository: $REPO"

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
ensure_single_select_field "$PROJECT_NUMBER" 'Milestone' 'M0,M1,M2,M3,M4,M5'
ensure_single_select_field "$PROJECT_NUMBER" 'Size' 'XS,S,M,L,XL'

# The approved backlog is materialized as issues #1-#130. Fail loudly rather than
# silently creating out-of-order issue numbers; missing items must be recreated by title
# from the approved plan before relationships are synchronized.
for n in $(seq 1 130); do
  if ! gh api -H "X-GitHub-Api-Version: $API_VERSION" "repos/$REPO/issues/$n" >/dev/null 2>&1; then
    die "approved backlog issue #$n is missing; recreate it from the approved implementation plan before rerunning"
  fi
done

for n in $(seq 1 130); do sync_issue "$n"; done

log "synchronized labels, M0-M5 milestones, project fields/items, sub-issues, dependencies, and design Done state"
