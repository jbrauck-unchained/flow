#!/usr/bin/env bash
# Runs the Flow prioritization pass once. Intended for a scheduled morning run.
#
# Agent-agnostic on purpose: set FLOW_AGENT_CMD to whatever you drive. The prompt
# is passed on stdin.
#
#   FLOW_AGENT_CMD="codex exec"   (default)
#   FLOW_AGENT_CMD="claude -p"
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLOW_DIR="${FLOW_DIR:-$HOME/.flow}"
STAMP="$FLOW_DIR/.last-prioritize"
AGENT_CMD="${FLOW_AGENT_CMD:-codex exec}"

mkdir -p "$FLOW_DIR"
SINCE=0
[ -f "$STAMP" ] && SINCE="$(cat "$STAMP")"

# Make `flow` reachable. Prefer the installed copy; fall back to a local build so
# the runner still works in a checkout that has not been installed yet.
export PATH="$HOME/.local/bin:$HERE/../dist-cli:$PATH"
if ! command -v flow >/dev/null 2>&1; then
  echo "run-prioritize: no 'flow' on PATH - run 'npm run install:cli'" >&2
  exit 1
fi
export FLOW_ACTOR="agent:prioritize"
export SINCE

# Refresh the contract so a drifting copy can't quietly go stale.
flow init >/dev/null

# Stamp before running, not after: a crashed run must not cause the next one to
# re-read feedback it already acted on.
date +%s000 > "$STAMP"

# [$] rather than \$ so the dollar is unambiguously literal in every sed.
sed "s/[\$]SINCE/$SINCE/g" "$HERE/prioritize.md" | $AGENT_CMD

# The agent emits signals; the scoring is ours. Running it here rather than asking
# the agent to means the ranking is reproducible and the weights stay inspectable.
flow score

# Checkpoint whatever the run changed.
flow snapshot -m "flow: prioritization run $(date +%Y-%m-%d)"
