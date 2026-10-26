#!/usr/bin/env bash
#
# test-postgres.sh — run the server tests against PostgreSQL with one command.
# `task test-server-postgres` runs this; arguments are passed to `go test`
# (e.g. `task test-server-postgres -- -run TestCreateNote`).
#
# Every Postgres-capable test runs against Postgres: the store and migration
# tests (via TEST_POSTGRES_DSN, see internal/database/dsntest) and the HTTP
# integration suite (via JOT_TEST_DB_DRIVER=postgres). Each test creates and
# drops its own database, so one server serves the whole run.
#
# The server is the first of these that works:
#   1. TEST_POSTGRES_DSN, if already set — used as is, nothing is started
#   2. initdb/pg_ctl — a throwaway cluster in a temp dir on a free port
#   3. Docker — the same image CI uses, on a free port
# Anything this script starts is torn down on exit.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT
# Same image as the README recipe; CI pins it by digest in server-ci.yml.
readonly DOCKER_IMAGE="postgres:18-alpine"
# The suite runs tests in parallel and every test server keeps its own
# connection pool, which outgrows Postgres's default of 100.
readonly MAX_CONNECTIONS=500

log() { printf '[test-postgres] %s\n' "$*" >&2; }

die() {
  printf '[test-postgres] ERROR: %s\n' "$*" >&2
  exit 1
}

cleanup_cmds=()
cleanup() {
  local cmd
  for cmd in "${cleanup_cmds[@]}"; do
    eval "$cmd" || true
  done
}
trap cleanup EXIT

# free_port prints a TCP port nothing on 127.0.0.1 is listening on. Racy in
# principle, but the window before the server binds it is short.
free_port() {
  local port
  for _ in $(seq 1 50); do
    port=$((20000 + RANDOM % 40000))
    if ! (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
      echo "$port"
      return
    fi
  done
  die "could not find a free port"
}

# pg_bin_dir prints the directory holding initdb and pg_ctl: PATH first, then
# Debian/Ubuntu's versioned layout, which keeps them off PATH.
pg_bin_dir() {
  if command -v initdb >/dev/null 2>&1 && command -v pg_ctl >/dev/null 2>&1; then
    dirname "$(command -v initdb)"
    return
  fi
  local dir
  dir="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -n1)"
  if [ -n "$dir" ] && [ -x "$dir/initdb" ] && [ -x "$dir/pg_ctl" ]; then
    echo "$dir"
  fi
}

start_local_cluster() {
  local bin_dir="$1" port data_dir run_as=()
  port="$(free_port)"
  data_dir="$(mktemp -d "${TMPDIR:-/tmp}/jot-test-postgres.XXXXXX")"
  cleanup_cmds+=("rm -rf '$data_dir'")

  # initdb refuses to run as root, which is how containers (including Claude
  # cloud sessions) usually run, so drop to an unprivileged user there.
  if [ "$(id -u)" = "0" ]; then
    local user=postgres
    id "$user" >/dev/null 2>&1 || user=nobody
    chown "$user" "$data_dir"
    run_as=(runuser -u "$user" --)
  fi

  log "starting a throwaway cluster with $bin_dir on port $port"
  ${run_as[@]+"${run_as[@]}"} "$bin_dir/initdb" -D "$data_dir/data" -U jot --auth=trust \
    --encoding=UTF8 --no-locale >/dev/null
  # Registered before starting, so a start that fails after the server came up
  # still stops it. Prepended: the server must stop before its dir is removed.
  cleanup_cmds=("${run_as[*]-} '$bin_dir/pg_ctl' -D '$data_dir/data' -m immediate stop >/dev/null 2>&1" "${cleanup_cmds[@]}")
  # The socket goes in the temp dir: the default /var/run/postgresql may not
  # exist or be writable.
  ${run_as[@]+"${run_as[@]}"} "$bin_dir/pg_ctl" -D "$data_dir/data" -l "$data_dir/postgres.log" -w \
    -o "-p $port -k $data_dir -c listen_addresses=127.0.0.1 -c max_connections=$MAX_CONNECTIONS -c fsync=off" \
    start >/dev/null || {
    cat "$data_dir/postgres.log" >&2
    die "pg_ctl failed to start the cluster"
  }

  export TEST_POSTGRES_DSN="postgres://jot@127.0.0.1:$port/postgres?sslmode=disable"
}

start_docker() {
  local port name
  port="$(free_port)"
  name="jot-test-postgres-$$"

  log "starting $DOCKER_IMAGE in Docker on port $port"
  docker run --rm -d --name "$name" \
    -e POSTGRES_USER=jot -e POSTGRES_PASSWORD=jot -e POSTGRES_DB=jot_test \
    -p "127.0.0.1:$port:5432" "$DOCKER_IMAGE" \
    -c max_connections="$MAX_CONNECTIONS" -c fsync=off >/dev/null
  cleanup_cmds+=("docker rm -f '$name' >/dev/null 2>&1")

  # pg_isready over TCP from inside the container: the image's entrypoint runs
  # a temporary socket-only server during init, which would pass a socket check.
  local _
  for _ in $(seq 1 60); do
    if docker exec "$name" pg_isready -h 127.0.0.1 -U jot >/dev/null 2>&1; then
      export TEST_POSTGRES_DSN="postgres://jot:jot@127.0.0.1:$port/jot_test?sslmode=disable"
      return
    fi
    sleep 1
  done
  docker logs "$name" >&2 || true
  die "Postgres in Docker did not become ready within 60s"
}

if [ -n "${TEST_POSTGRES_DSN:-}" ]; then
  log "using TEST_POSTGRES_DSN from the environment"
elif bin_dir="$(pg_bin_dir)" && [ -n "$bin_dir" ]; then
  start_local_cluster "$bin_dir"
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  start_docker
else
  die "no Postgres available. Do one of:
  - install the PostgreSQL server binaries (initdb, pg_ctl), e.g. apt install postgresql
  - start Docker
  - set TEST_POSTGRES_DSN to a server the tests may create databases on"
fi

export JOT_TEST_DB_DRIVER=postgres
cd "$REPO_ROOT/server"
go test "$@" ./...
