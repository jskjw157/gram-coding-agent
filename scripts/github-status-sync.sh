#!/usr/bin/env bash
set -euo pipefail

PROJECT_TITLE='Gram Coding Agent — Engineering'

log() { printf '[github-status-sync] %s\n' "$*" >&2; }
die() { printf '[github-status-sync] ERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"; }

need gh
need jq
need date
need sleep

gh auth status >/dev/null 2>&1 || die 'GitHub CLI is not authenticated'

REPO="${GH_REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
OWNER="${REPO%%/*}"
REPO_NAME="${REPO#*/}"
[[ -n "$OWNER" && -n "$REPO_NAME" && "$OWNER" != "$REPO_NAME" ]] || die "invalid repository: $REPO"

is_rate_limit_error() {
  grep -qiE 'rate limit exceeded|API rate limit exceeded|secondary rate limit' <<<"$1"
}

wait_for_graphql_reset() {
  local reset_epoch now wait_seconds
  reset_epoch="$(gh api rate_limit --jq '.resources.graphql.reset // empty' 2>/dev/null || true)"
  now="$(date +%s)"
  if [[ "$reset_epoch" =~ ^[0-9]+$ ]]; then
    wait_seconds=$(( reset_epoch - now + 5 ))
    (( wait_seconds < 1 )) && wait_seconds=1
  else
    wait_seconds=60
  fi
  log "GitHub GraphQL rate limit exceeded; sleeping ${wait_seconds}s until reset before retry"
  sleep "$wait_seconds"
}

gh_retry() {
  local output rc
  while true; do
    set +e
    output="$(gh "$@" 2>&1)"
    rc=$?
    set -e
    if (( rc == 0 )); then
      printf '%s\n' "$output"
      return 0
    fi
    if is_rate_limit_error "$output"; then
      wait_for_graphql_reset
      continue
    fi
    printf '%s\n' "$output" >&2
    return "$rc"
  done
}

gh_retry_stdin() {
  local input="$1" output rc
  shift
  while true; do
    set +e
    output="$(gh "$@" <<<"$input" 2>&1)"
    rc=$?
    set -e
    if (( rc == 0 )); then
      printf '%s\n' "$output"
      return 0
    fi
    if is_rate_limit_error "$output"; then
      wait_for_graphql_reset
      continue
    fi
    printf '%s\n' "$output" >&2
    return "$rc"
  done
}

PROJECT_LIST="$(gh_retry project list --owner "$OWNER" --format json --limit 100)" || \
  die 'GitHub token cannot access Projects v2; authenticate gh with project scope'
PROJECT_JSON="$(jq -c --arg title "$PROJECT_TITLE" '.projects[] | select(.title == $title)' <<<"$PROJECT_LIST" | head -n1)"
[[ -n "$PROJECT_JSON" ]] || die "project not found: $PROJECT_TITLE"
PROJECT_NUMBER="$(jq -r .number <<<"$PROJECT_JSON")"
PROJECT_ID="$(jq -r .id <<<"$PROJECT_JSON")"
[[ "$PROJECT_NUMBER" =~ ^[0-9]+$ ]] || die "invalid project number: $PROJECT_NUMBER"
[[ -n "$PROJECT_ID" && "$PROJECT_ID" != null ]] || die "project node ID missing: $PROJECT_TITLE"
readonly PROJECT_NUMBER PROJECT_ID

PROJECT_FIELDS_JSON="$(gh_retry project field-list "$PROJECT_NUMBER" --owner "$OWNER" --format json --limit 100)"
STATUS_FIELD_JSON="$(jq -c '.fields[]? | select(.name == "Status")' <<<"$PROJECT_FIELDS_JSON" | head -n1)"
[[ -n "$STATUS_FIELD_JSON" ]] || die 'Project Status field not found'
field_id="$(jq -r .id <<<"$STATUS_FIELD_JSON")"
option_id="$(jq -r '.options[]? | select(.name == "Done") | .id' <<<"$STATUS_FIELD_JSON" | head -n1)"
[[ -n "$field_id" && "$field_id" != null ]] || die 'Project Status field node ID missing'
[[ -n "$option_id" && "$option_id" != null ]] || die 'Project Status=Done option node ID missing'
readonly field_id option_id

PROJECT_ITEMS_JSON="$(gh_retry project item-list "$PROJECT_NUMBER" --owner "$OWNER" --format json --limit 500)"
ISSUES_JSON="$(gh issue list --repo "$REPO" --state all --limit 500 --json number,state,url,title)"

project_item_id_for_url() {
  local url="$1"
  jq -r --arg url "$url" '.items[]? | select(.content.url == $url) | .id' <<<"$PROJECT_ITEMS_JSON" | head -n1
}

cache_project_item() {
  local item_id="$1" url="$2"
  PROJECT_ITEMS_JSON="$(jq -c --arg id "$item_id" --arg url "$url" \
    '.items += [{id:$id,content:{url:$url}}]' <<<"$PROJECT_ITEMS_JSON")"
}

resolve_project_item_id_for_issue() {
  local url="$1" issue_number query payload response
  issue_number="${url##*/}"
  [[ "$issue_number" =~ ^[0-9]+$ ]] || return 1
  query='query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){issue(number:$number){projectItems(first:20){nodes{id project{id}}}}}}'
  payload="$(jq -nc --arg query "$query" --arg owner "$OWNER" --arg repo "$REPO_NAME" --argjson number "$issue_number" \
    '{query:$query,variables:{owner:$owner,repo:$repo,number:$number}}')"
  response="$(gh_retry_stdin "$payload" api graphql --input -)" || return 1
  jq -r --arg project "$PROJECT_ID" \
    '.data.repository.issue.projectItems.nodes[]? | select(.project.id == $project) | .id' <<<"$response" | head -n1
}

ensure_project_item() {
  local url="$1" item_id attempt added_json
  item_id="$(project_item_id_for_url "$url")"
  if [[ -n "$item_id" ]]; then
    printf '%s\n' "$item_id"
    return 0
  fi

  added_json="$(gh_retry project item-add "$PROJECT_NUMBER" --owner "$OWNER" --url "$url" --format json)" || \
    die "failed to add Project item: $url"
  item_id="$(jq -r '.id // empty' <<<"$added_json" 2>/dev/null || true)"

  if [[ -z "$item_id" ]]; then
    for attempt in $(seq 1 5); do
      item_id="$(resolve_project_item_id_for_issue "$url" || true)"
      if [[ -n "$item_id" ]]; then
        break
      fi
      if (( attempt < 5 )); then
        log "Project item not visible yet after add; lightweight retry ($attempt/5): $url"
        sleep 1
      fi
    done
  fi

  [[ -n "$item_id" ]] || die "Project item node ID missing after add: $url"
  cache_project_item "$item_id" "$url"
  printf '%s\n' "$item_id"
}

for number in $(seq 1 36); do
  issue="$(jq -c --argjson number "$number" '.[] | select(.number == $number)' <<<"$ISSUES_JSON")"
  [[ -n "$issue" ]] || die "expected backlog issue #$number is missing"

  state="$(jq -r .state <<<"$issue")"
  title="$(jq -r .title <<<"$issue")"
  url="$(jq -r .url <<<"$issue")"

  if [[ "$state" != 'CLOSED' ]]; then
    log "preserve open issue #$number: $title"
    continue
  fi

  item_id="$(ensure_project_item "$url")"

  gh_retry project item-edit \
    --id "$item_id" \
    --project-id "$PROJECT_ID" \
    --field-id "$field_id" \
    --single-select-option-id "$option_id" >/dev/null
  log "marked Done from recorded closed state: #$number $title"
done

log 'M0-M1 Project status synchronization complete; open issues were preserved unchanged'
