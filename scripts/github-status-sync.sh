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
PROJECT_NUMBER="$(jq -r --arg title "$PROJECT_TITLE" '.projects[] | select(.title == $title) | .number' <<<"$PROJECT_LIST" | head -n1)"
[[ -n "$PROJECT_NUMBER" ]] || die "project not found: $PROJECT_TITLE"

ISSUES_JSON="$(gh issue list --repo "$REPO" --state all --limit 500 --json number,state,url,title)"

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

  if ! gh project item-list "$PROJECT_NUMBER" --owner "$OWNER" --format json --limit 500 \
      --jq ".items[]? | select(.content.url == \"$url\") | .content.url" | grep -Fxq "$url"; then
    gh project item-add "$PROJECT_NUMBER" --owner "$OWNER" --url "$url" >/dev/null
  fi

  gh project item-edit "$PROJECT_NUMBER" --owner "$OWNER" --url "$url" --field 'Status' --value 'Done' >/dev/null
  log "marked Done from recorded closed state: #$number $title"
done

log 'M0-M1 Project status synchronization complete; open issues were preserved unchanged'
