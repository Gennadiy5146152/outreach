#!/usr/bin/env bash

set -Eeuo pipefail

PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

OUTREACH_DIR=${OUTREACH_DIR:-/root/outreach}
OUTREACH_BACKUP_DIR=${OUTREACH_BACKUP_DIR:-/var/backups/outreach}
OUTREACH_STATE_DIR=${OUTREACH_STATE_DIR:-/var/lib/outreach-deploy}
OUTREACH_LOCK_FILE=${OUTREACH_LOCK_FILE:-/var/lock/outreach-deploy.lock}
OUTREACH_ENV_FILE=${OUTREACH_ENV_FILE:-$OUTREACH_DIR/.env}
OUTREACH_STORAGE_DIR=${OUTREACH_STORAGE_DIR:-$OUTREACH_DIR/storage}
OUTREACH_RUNTIME_ENV_FILE=${OUTREACH_RUNTIME_ENV_FILE:-$OUTREACH_STORAGE_DIR/runtime.env}
OUTREACH_HEALTH_URL=${OUTREACH_HEALTH_URL:-http://127.0.0.1:3000/api/health}
OUTREACH_PROJECT=${OUTREACH_PROJECT:-outreach-desk}
OUTREACH_POSTGRES_CONTAINER=${OUTREACH_POSTGRES_CONTAINER:-outreach-desk-postgres-1}
OUTREACH_WEB_CONTAINER=${OUTREACH_WEB_CONTAINER:-outreach-desk-web-1}
OUTREACH_PERSONALIZER_CONTAINER=${OUTREACH_PERSONALIZER_CONTAINER:-outreach-desk-personalizer-1}
OUTREACH_VOLUME=${OUTREACH_VOLUME:-outreach-desk_postgres_data}
OUTREACH_COMPOSE_FILE=${OUTREACH_COMPOSE_FILE:-$OUTREACH_DIR/docker-compose.prod.yml}
OUTREACH_LEGACY_COMPOSE_FILE=${OUTREACH_LEGACY_COMPOSE_FILE:-$OUTREACH_DIR/docker-compose.yml}
OUTREACH_CURRENT_FILE=${OUTREACH_CURRENT_FILE:-$OUTREACH_STATE_DIR/current-sha}
OUTREACH_PREVIOUS_FILE=${OUTREACH_PREVIOUS_FILE:-$OUTREACH_STATE_DIR/previous-sha}

log() {
  printf '[%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"
}

die() {
  log "ERROR: $*" >&2
  return 1
}

parse_requested_sha() {
  local command_text=${1:-}
  local requested_sha

  if [[ ! "$command_text" =~ ^deploy[[:space:]]+([[:xdigit:]]{40}|[[:xdigit:]]{64})$ ]]; then
    return 64
  fi

  requested_sha=${BASH_REMATCH[1]}
  printf '%s' "$requested_sha" | tr '[:upper:]' '[:lower:]'
  printf '\n'
}

compose() {
  OUTREACH_IMAGE_TAG=${OUTREACH_IMAGE_TAG:?OUTREACH_IMAGE_TAG is required} \
  OUTREACH_ENV_FILE="$OUTREACH_ENV_FILE" \
  OUTREACH_RUNTIME_ENV_FILE="$OUTREACH_RUNTIME_ENV_FILE" \
  OUTREACH_STORAGE_DIR="$OUTREACH_STORAGE_DIR" \
    docker compose \
      -p "$OUTREACH_PROJECT" \
      --env-file "$OUTREACH_ENV_FILE" \
      -f "$OUTREACH_COMPOSE_FILE" \
      "$@"
}

acquire_lock() {
  mkdir -p "$(dirname "$OUTREACH_LOCK_FILE")"
  exec 9>"$OUTREACH_LOCK_FILE"
  flock -n 9 || die "another Outreach deployment is already running"
}

verify_preconditions() {
  local dirty

  [[ $(id -u) -eq 0 ]] || die "deployment must run as root"
  [[ -d "$OUTREACH_DIR/.git" ]] || die "$OUTREACH_DIR is not a Git checkout"
  [[ -f "$OUTREACH_ENV_FILE" ]] || die "server environment file is missing"
  [[ -d "$OUTREACH_STORAGE_DIR" ]] || die "attachment storage directory is missing"
  command -v git >/dev/null || die "git is not installed"
  command -v docker >/dev/null || die "docker is not installed"
  command -v flock >/dev/null || die "flock is not installed"
  command -v gzip >/dev/null || die "gzip is not installed"
  command -v curl >/dev/null || die "curl is not installed"
  docker volume inspect "$OUTREACH_VOLUME" >/dev/null 2>&1 || die "PostgreSQL volume $OUTREACH_VOLUME is missing"
  [[ $(docker inspect -f '{{.State.Running}}' "$OUTREACH_POSTGRES_CONTAINER" 2>/dev/null) == true ]] \
    || die "PostgreSQL container is not running"

  dirty=$(git -C "$OUTREACH_DIR" status --porcelain --untracked-files=no)
  [[ -z "$dirty" ]] || die "tracked server files have local changes"
}

verify_main_ancestry() {
  local requested_sha=$1

  git -C "$OUTREACH_DIR" fetch --prune origin main
  git -C "$OUTREACH_DIR" cat-file -e "${requested_sha}^{commit}" 2>/dev/null \
    || die "requested commit does not exist"
  git -C "$OUTREACH_DIR" merge-base --is-ancestor "$requested_sha" refs/remotes/origin/main \
    || die "requested commit is not reachable from origin/main"
}

current_deployed_sha() {
  local recorded=""

  if [[ -f "$OUTREACH_CURRENT_FILE" ]]; then
    recorded=$(tr -d '\r\n' < "$OUTREACH_CURRENT_FILE")
    if [[ "$recorded" =~ ^[[:xdigit:]]{40}$|^[[:xdigit:]]{64}$ ]]; then
      printf '%s\n' "$recorded"
      return 0
    fi
  fi

  git -C "$OUTREACH_DIR" rev-parse HEAD
}

backup_database() {
  local timestamp temporary destination

  mkdir -p "$OUTREACH_BACKUP_DIR"
  timestamp=$(date -u +'%Y%m%dT%H%M%SZ')
  destination="$OUTREACH_BACKUP_DIR/outreach-${timestamp}.sql.gz"
  temporary="${destination}.tmp"

  log "creating PostgreSQL backup"
  rm -f "$temporary"
  if ! docker exec "$OUTREACH_POSTGRES_CONTAINER" \
    sh -ceu 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' \
    | gzip -c > "$temporary"; then
    rm -f "$temporary"
    die "database backup command failed"
    return 1
  fi
  if [[ ! -s "$temporary" ]]; then
    rm -f "$temporary"
    die "database backup is empty"
    return 1
  fi
  if ! gzip -t "$temporary"; then
    rm -f "$temporary"
    die "database backup is corrupt"
    return 1
  fi
  mv "$temporary" "$destination"
  log "database backup created at $destination"
}

prepare_storage_permissions() {
  touch "$OUTREACH_RUNTIME_ENV_FILE"
  chown -R 1000:1000 "$OUTREACH_STORAGE_DIR"
  chmod 0600 "$OUTREACH_RUNTIME_ENV_FILE"
}

stop_web() {
  if docker inspect "$OUTREACH_PERSONALIZER_CONTAINER" >/dev/null 2>&1; then
    log "stopping personalizer container"
    docker stop --time 30 "$OUTREACH_PERSONALIZER_CONTAINER" >/dev/null
  fi
  if docker inspect "$OUTREACH_WEB_CONTAINER" >/dev/null 2>&1; then
    log "stopping web container"
    docker stop --time 30 "$OUTREACH_WEB_CONTAINER" >/dev/null
  fi
}

checkout_commit() {
  local requested_sha=$1
  git -C "$OUTREACH_DIR" checkout --detach "$requested_sha"
}

build_commit() {
  local requested_sha=$1
  OUTREACH_IMAGE_TAG=$requested_sha compose build web
}

run_migrations() {
  local requested_sha=$1
  OUTREACH_IMAGE_TAG=$requested_sha compose run --rm --no-deps migrate
}

start_web() {
  local requested_sha=$1
  OUTREACH_IMAGE_TAG=$requested_sha compose up -d --no-deps web personalizer
}

wait_for_health() {
  local attempt container_health container_state

  for attempt in $(seq 1 24); do
    container_health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$OUTREACH_WEB_CONTAINER" 2>/dev/null || true)
    container_state=$(docker inspect -f '{{.State.Status}}' "$OUTREACH_WEB_CONTAINER" 2>/dev/null || true)
    if { [[ "$container_health" == healthy ]] || { [[ -z "$container_health" ]] && [[ "$container_state" == running ]]; }; } \
      && curl -fsS --max-time 5 "$OUTREACH_HEALTH_URL" >/dev/null; then
      log "web health check passed"
      return 0
    fi
    sleep 5
  done

  die "web health check failed"
}

record_deployed_sha() {
  local deployed_sha=$1
  local previous_sha=${2:-}

  mkdir -p "$OUTREACH_STATE_DIR"
  if [[ -n "$previous_sha" ]]; then
    printf '%s\n' "$previous_sha" > "$OUTREACH_PREVIOUS_FILE"
  fi
  printf '%s\n' "$deployed_sha" > "$OUTREACH_CURRENT_FILE"
}

rollback_application() {
  local previous_sha=$1

  [[ -n "$previous_sha" ]] || die "previous application commit is unknown"
  log "rolling application back to $previous_sha"
  git -C "$OUTREACH_DIR" checkout --detach "$previous_sha" || return $?

  if [[ -f "$OUTREACH_COMPOSE_FILE" ]]; then
    if ! docker image inspect "outreach-desk-app:${previous_sha}" >/dev/null 2>&1; then
      build_commit "$previous_sha" || return $?
    fi
    start_web "$previous_sha" || return $?
  elif [[ -f "$OUTREACH_LEGACY_COMPOSE_FILE" ]]; then
    docker compose \
      -p "$OUTREACH_PROJECT" \
      --env-file "$OUTREACH_ENV_FILE" \
      -f "$OUTREACH_LEGACY_COMPOSE_FILE" \
      up -d --no-deps web personalizer || return $?
  else
    die "neither production nor legacy Compose file exists for rollback"
    return 1
  fi

  wait_for_health || return $?
  record_deployed_sha "$previous_sha" || return $?
  log "application rollback completed"
}

prune_artifacts() {
  local backup image count=0

  while IFS= read -r backup; do
    [[ -n "$backup" ]] && rm -f -- "$backup"
  done < <(find "$OUTREACH_BACKUP_DIR" -maxdepth 1 -type f -name 'outreach-*.sql.gz' -print \
    | sort -r | tail -n +8)

  while IFS= read -r image; do
    [[ -n "$image" ]] || continue
    count=$((count + 1))
    if (( count > 2 )); then
      docker image rm "$image" >/dev/null 2>&1 || true
    fi
  done < <(docker image ls outreach-desk-app --format '{{.Repository}}:{{.Tag}}')
}

DEPLOY_TRANSACTION_ACTIVE=0
DEPLOY_PREVIOUS_SHA=""

handle_deploy_signal() {
  local signal_name=$1
  local exit_code=$2
  local rollback_status=0

  trap - HUP INT TERM
  log "deployment interrupted by $signal_name" >&2
  if (( DEPLOY_TRANSACTION_ACTIVE != 0 )); then
    rollback_application "$DEPLOY_PREVIOUS_SHA" || rollback_status=$?
    if (( rollback_status != 0 )); then
      log "ERROR: rollback after $signal_name failed with status $rollback_status" >&2
    fi
    prune_artifacts || true
  fi
  exit "$exit_code"
}

deploy_sha() {
  local requested_sha=$1
  local previous_sha deploy_status rollback_status

  acquire_lock
  verify_preconditions "$requested_sha"
  verify_main_ancestry "$requested_sha"
  previous_sha=$(current_deployed_sha)
  backup_database
  prepare_storage_permissions
  DEPLOY_PREVIOUS_SHA=$previous_sha
  DEPLOY_TRANSACTION_ACTIVE=1
  trap 'handle_deploy_signal HUP 129' HUP
  trap 'handle_deploy_signal INT 130' INT
  trap 'handle_deploy_signal TERM 143' TERM
  stop_web

  deploy_status=0
  checkout_commit "$requested_sha" \
    && build_commit "$requested_sha" \
    && run_migrations "$requested_sha" \
    && start_web "$requested_sha" \
    && wait_for_health \
    || deploy_status=$?

  if (( deploy_status != 0 )); then
    trap - HUP INT TERM
    log "deployment failed; attempting application rollback" >&2
    rollback_status=0
    rollback_application "$previous_sha" || rollback_status=$?
    if (( rollback_status != 0 )); then
      log "ERROR: rollback also failed with status $rollback_status" >&2
    fi
    DEPLOY_TRANSACTION_ACTIVE=0
    prune_artifacts || true
    return "$deploy_status"
  fi

  trap - HUP INT TERM
  DEPLOY_TRANSACTION_ACTIVE=0
  record_deployed_sha "$requested_sha" "$previous_sha"
  prune_artifacts
  log "deployed $requested_sha"
}

main() {
  local command_text requested_sha

  if (( $# > 0 )); then
    command_text="$*"
  else
    command_text=${SSH_ORIGINAL_COMMAND:-}
  fi

  requested_sha=$(parse_requested_sha "$command_text") \
    || die "expected exactly: deploy <commit-sha>"
  deploy_sha "$requested_sha"
}

if [[ ${OUTREACH_DEPLOY_LIBRARY_ONLY:-0} != 1 ]]; then
  main "$@"
fi
