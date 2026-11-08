#!/usr/bin/env bash
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"

STATE_DIR="$HOME/hooks/state/upstream-update"
mkdir -p "$STATE_DIR"
BASELINE_FILE="$HOME/workspace/custom-connectors/custom.upstream/.upstream_sha"
NOTIFIED_FILE="$STATE_DIR/notified_sha"

baseline="$(tr -d '[:space:]' < "$BASELINE_FILE" 2>/dev/null || true)"
if [ -z "$baseline" ]; then
  log "baseline_missing" '{}'
  silent "baseline SHA file missing or empty" '{}'
fi

remote_line="$(git ls-remote https://CODE_HOST/UPSTREAM_REPO HEAD 2>/dev/null | head -1 || true)"
remote="$(printf '%s' "$remote_line" | awk '{print $1}')"
if ! printf '%s' "$remote" | grep -qE '^[0-9a-f]{40}$'; then
  log "fetch_failed" '{}'
  silent "could not fetch remote HEAD" '{}'
fi

if [ "$remote" = "$baseline" ]; then
  silent "no change" "{\"head\":\"$remote\"}"
fi

notified="$(tr -d '[:space:]' < "$NOTIFIED_FILE" 2>/dev/null || true)"
if [ "$remote" = "$notified" ]; then
  silent "already notified for this HEAD" "{\"head\":\"$remote\"}"
fi

if [ "${HATCH_HOOK_DRY_RUN:-0}" != "1" ]; then
  printf '%s' "$remote" > "$NOTIFIED_FILE"
fi

log "update_detected" "{\"installed\":\"$baseline\",\"head\":\"$remote\"}"
wake "upstream repository updated" "{\"installed_sha\":\"$baseline\",\"new_sha\":\"$remote\"}"
