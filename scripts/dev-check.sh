#!/usr/bin/env bash
# Milestone 1 checks against REAL local services. Run scripts/dev-bootstrap.sh first.
#   scripts/dev-check.sh           services + typecheck + lint + build + HTTP check of the built app
#   scripts/dev-check.sh --quick   services + typecheck + lint
# Paid provider requests run only when CHECK_PROVIDER=1 is set.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

QUICK=0
[[ "${1:-}" == "--quick" ]] && QUICK=1
APP_PORT="${CHECK_APP_PORT:-3199}"
failures=()

step() {
  local name="$1"
  shift
  printf '\n== %s\n' "$name"
  if "$@"; then
    printf -- '-> PASS %s\n' "$name"
  else
    printf -- '-> FAIL %s\n' "$name"
    failures+=("$name")
  fi
}

versions() {
  echo "node $(node --version), pnpm $(pnpm --version)"
  echo "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo 'daemon unavailable'), compose $(docker compose version --short)"
  docker compose ps --format '{{.Service}} {{.Status}} {{.Ports}}'
  docker info >/dev/null 2>&1
}

http_check() {
  local log=".temp/check-next-start.log"
  mkdir -p .temp
  # setsid gives the server its own process group so the whole tree can be stopped afterwards.
  PORT="$APP_PORT" NEXT_TELEMETRY_DISABLED=1 setsid pnpm -s start >"$log" 2>&1 &
  local pid=$!
  local ok=1
  for _ in $(seq 1 30); do
    curl -fsS -o /dev/null "http://127.0.0.1:${APP_PORT}/" && break
    sleep 1
  done
  if curl -fsS "http://127.0.0.1:${APP_PORT}/" | grep -q "<h1>Company Brain</h1>"; then
    echo "GET / -> 200 with heading"
    local health
    health="$(curl -sS "http://127.0.0.1:${APP_PORT}/api/health")"
    echo "GET /api/health -> $health"
    [[ "$health" == *'"status":"ok"'* ]] && ok=0
  else
    echo "home page did not respond; see $log"
  fi
  kill -- "-$pid" >/dev/null 2>&1 || true
  wait "$pid" 2>/dev/null || true
  return "$ok"
}

bundle_secret_scan() {
  # Browser assets must never contain server credentials or connection strings.
  if grep -rlE 'company_brain_dev|postgresql://|DATABASE_URL|OPENAI_API_KEY|sk-[A-Za-z0-9_-]{20,}' .next/static; then
    echo "server configuration found in browser bundle"
    return 1
  fi
  echo "no server configuration found in .next/static"
}

step "tool versions and docker" versions
step "real services (postgres + falkordb)" pnpm -s check:services
step "typecheck" pnpm -s typecheck
step "lint" pnpm -s lint
if [[ "$QUICK" == 0 ]]; then
  step "production build" env NEXT_TELEMETRY_DISABLED=1 pnpm -s build
  step "browser bundle secret scan" bundle_secret_scan
  step "app HTTP check" http_check
fi
if [[ "${CHECK_PROVIDER:-0}" == 1 ]]; then
  step "model provider (paid, minimal)" pnpm -s check:provider
fi

printf '\n'
if ((${#failures[@]})); then
  printf 'FAILED: %s\n' "${failures[@]}"
  exit 1
fi
echo "ALL CHECKS PASSED"
