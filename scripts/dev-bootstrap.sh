#!/usr/bin/env bash
# Lightweight, rerunnable dev bootstrap: dependencies, local services, minimal migrations.
# It never runs ingestion, extraction, embeddings, graph rebuilds, or paid model calls.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FALKORDB_IMAGE="falkordb/falkordb:v4.20.7"
# Docker Hub manifest digest for the tag above; used to verify the mirror fallback image.
FALKORDB_DIGEST="sha256:13996aa523f0dd283f6bd6df6620b094dcea525452417c4d6ef9bef15dc9998d"
DOCKER_WAIT_SECONDS=45
SERVICE_WAIT_SECONDS=120

log() { printf '[bootstrap] %s\n' "$*"; }
fail() { printf '[bootstrap] ERROR: %s\n' "$*" >&2; exit 1; }

log "node $(node --version), pnpm $(pnpm --version)"
command -v docker >/dev/null || fail "docker CLI not found"
docker compose version >/dev/null 2>&1 || fail "docker compose plugin not found"

# Environment snapshots keep files, not processes: the daemon may need starting on every resume.
wait_for_docker() {
  local seconds="$1"
  for _ in $(seq 1 "$seconds"); do
    docker info >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}
# A restored snapshot keeps PID files from the old VM. If the managed-containerd PID now belongs
# to another process, dockerd waits for a containerd that never starts, so drop stale files first.
clear_stale_pidfiles() {
  local pidfile=/var/run/docker/containerd/containerd.pid pid
  if [[ -f "$pidfile" ]]; then
    pid="$(cat "$pidfile" 2>/dev/null || true)"
    if [[ -z "$pid" || "$(cat "/proc/$pid/comm" 2>/dev/null || true)" != "containerd" ]]; then
      log "removing stale containerd PID file"
      rm -f "$pidfile"
    fi
  fi
  if [[ -f /var/run/docker.pid ]] && ! pgrep -x dockerd >/dev/null; then rm -f /var/run/docker.pid; fi
}

if ! docker info >/dev/null 2>&1; then
  log "starting Docker daemon"
  # The cloud VM's init script can fail (ulimit is not permitted), so fall back to dockerd directly.
  if command -v service >/dev/null 2>&1; then
    service docker start >/dev/null 2>&1 || true
  fi
  if ! wait_for_docker 10; then
    command -v dockerd >/dev/null 2>&1 || fail "Docker daemon is not running and dockerd is not installed"
    mkdir -p .temp
    clear_stale_pidfiles
    nohup dockerd >.temp/dockerd.log 2>&1 &
    wait_for_docker "$DOCKER_WAIT_SECONDS" ||
      fail "Docker daemon did not become ready within ${DOCKER_WAIT_SECONDS}s; see .temp/dockerd.log"
  fi
fi
log "docker $(docker version --format '{{.Server.Version}}'), compose $(docker compose version --short)"

# Docker Hub rate-limits anonymous pulls (HTTP 429) on shared cloud egress. Fall back to Google's
# Docker Hub mirror, accepting the image only if its digest matches the pinned Docker Hub digest.
if ! docker image inspect "$FALKORDB_IMAGE" >/dev/null 2>&1; then
  log "pulling $FALKORDB_IMAGE"
  if ! docker pull --quiet "$FALKORDB_IMAGE" >/dev/null 2>&1; then
    log "Docker Hub pull failed; trying mirror.gcr.io"
    docker pull --quiet "mirror.gcr.io/$FALKORDB_IMAGE" >/dev/null || fail "could not pull $FALKORDB_IMAGE"
    mirror_digest="$(docker image inspect "mirror.gcr.io/$FALKORDB_IMAGE" --format '{{range .RepoDigests}}{{.}} {{end}}')"
    [[ "$mirror_digest" == *"$FALKORDB_DIGEST"* ]] || fail "mirror image digest does not match pinned digest"
    docker tag "mirror.gcr.io/$FALKORDB_IMAGE" "$FALKORDB_IMAGE"
  fi
fi

# Install only when the lockfile or manifest changed since the last install.
if [[ -f pnpm-lock.yaml ]]; then
  if [[ ! -f node_modules/.modules.yaml || pnpm-lock.yaml -nt node_modules/.modules.yaml || package.json -nt node_modules/.modules.yaml ]]; then
    log "installing locked dependencies"
    pnpm install --frozen-lockfile --reporter=silent
  else
    log "dependencies up to date"
  fi
else
  fail "pnpm-lock.yaml missing; run pnpm install deliberately and commit the lockfile"
fi

log "starting postgres and falkordb (waiting up to ${SERVICE_WAIT_SECONDS}s for health)"
docker compose up -d --wait --wait-timeout "$SERVICE_WAIT_SECONDS" postgres falkordb >/dev/null 2>&1 || {
  docker compose ps >&2 || true
  fail "services did not become healthy; inspect with: docker compose logs postgres falkordb"
}

log "applying migrations"
pnpm -s db:migrate

log "done"
