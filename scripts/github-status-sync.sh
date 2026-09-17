#!/usr/bin/env bash
set -euo pipefail

PROJECT_TITLE='Gram Coding Agent — Engineering'

log() { printf '[github-status-sync] %s\n' "$*" >&2; }
die() { printf '[github-status-sync] ERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"; }

need gh
need jq

gh auth status >/dev/null 2>&1 || die 'GitHub CLI is not authenticated'

REPO="${GH_REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
OWNER="${REPO%%/*}"
[[ -n "$OWNER" && "$OWNER" != "$REPO" ]] || die "invalid repository: $REPO"

PROJECT_LIST="$(gh project list --owner "$OWNER" --format json --limit 100)" || \
  die 'GitHub token cannot access Projects v2; authenticate gh with project scope'
PROJECT_JSON="$(jq -c --arg title "$PROJECT_TITLE" '.projects[] | select(.title == $title)' <<<"$PROJECT_LIST" | head -n1)"
[[ -n "$PROJECT_JSON" ]] || die "project not found: $PROJECT_TITLE"
PROJECT_NUMBER="$(jq -r .number <<<"$PROJECT_JSON")"
PROJECT_ID="$(jq -r .id <<<"$PROJECT_JSON")"
[[ "$PROJECT_NUMBER" =~ ^[0-9]+$ ]] || die "invalid project number: $PROJECT_NUMBER"
[[ -n "$PROJECT_ID" && "$PROJECT_ID" != null ]] || die "project node ID missing: $PROJECT_TITLE"
readonly PROJECT_NUMBER PROJECT_ID

PROJECT_FIELDS_JSON="$(gh project field-list "$PROJECT_NUMBER" --owner "$OWNER" --format json --limit 100)"
STATUS_FIELD_JSON="$(jq -c '.fields[]? | select(.name == "Status")' <<<"$PROJECT_FIELDS_JSON" | head -n1)"
[[ -n "$STATUS_FIELD_JSON" ]] || die 'Project Status field not found'
field_id="$(jq -r .id <<<"$STATUS_FIELD_JSON")"
option_id="$(jq -r '.options[]? | select(.name == "Done") | .id' <<<"$STATUS_FIELD_JSON" | head -n1)"
[[ -n "$field_id" && "$field_id" != null ]] || die 'Project Status field node ID missing'
[[ -n "$option_id" && "$option_id" != null ]] || die 'Project Status=Done option node ID missing'
readonly field_id option_id

PROJECT_ITEMS_JSON="$(gh project item-list "$PROJECT_NUMBER" --owner "$OWNER" --format json --limit 500)"
ISSUES_JSON="$(gh issue list --repo "$REPO" --state all --limit 500 --json number,state,url,title)"

project_item_id_for_url() {
  local url="$1"
  jq -r --arg url "$url" '.items[]? | select(.content.url == $url) | .id' <<<"$PROJECT_ITEMS_JSON" | head -n1
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

  item_id="$(project_item_id_for_url "$url")"
  if [[ -z "$item_id" ]]; then
    gh project item-add "$PROJECT_NUMBER" --owner "$OWNER" --url "$url" >/dev/null
    item_id="$(gh project item-list "$PROJECT_NUMBER" --owner "$OWNER" --format json --limit 500 \
      --jq ".items[]? | select(.content.url == \"$url\") | .id" | head -n1)"
  fi
  [[ -n "$item_id" ]] || die "Project item node ID missing for issue #$number"

  gh project item-edit \
    --id "$item_id" \
    --project-id "$PROJECT_ID" \
    --field-id "$field_id" \
    --single-select-option-id "$option_id" >/dev/null
  log "marked Done from recorded closed state: #$number $title"
done

log 'M0-M1 Project status synchronization complete; open issues were preserved unchanged'
