#!/usr/bin/env bash
# Cloud sessions only: restart local services and run the lightweight bootstrap. Bounded, and it
# never blocks the session on failure; the log tells the agent what to fix.
set -uo pipefail

if [[ "${CLAUDE_CODE_REMOTE:-}" != "true" ]]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" || exit 0
mkdir -p .temp
if timeout 300 bash scripts/dev-bootstrap.sh >.temp/session-start.log 2>&1; then
  echo "Company Brain dev bootstrap OK (postgres + falkordb up, migrations applied). Log: .temp/session-start.log"
else
  echo "Company Brain dev bootstrap FAILED; read .temp/session-start.log and run scripts/dev-bootstrap.sh"
fi
exit 0
