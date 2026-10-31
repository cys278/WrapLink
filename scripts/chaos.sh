#!/usr/bin/env bash
# Failure injection against the Docker Compose stack. Each scenario breaks
# one dependency while traffic flows, then checks the documented behaviour
# (docs/FAILURE_MODES.md). Run it against a local stack, never production.
#
#   docker compose up -d --build
#   API_KEY=... scripts/chaos.sh redis-down
#   API_KEY=... scripts/chaos.sh postgres-down
#   API_KEY=... scripts/chaos.sh app-restart
#   API_KEY=... scripts/chaos.sh all
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
API_KEY="${API_KEY:?Set API_KEY to a value from CREATE_API_KEYS}"
# Extra compose files, e.g. COMPOSE_FILES="-f docker-compose.yml -f docker-compose.write-behind.yml"
read -r -a compose_files <<< "${COMPOSE_FILES:--f docker-compose.yml}"
compose=(docker compose "${compose_files[@]}")

pass=0
fail=0

check() {
  local description="$1" expected="$2" actual="$3"
  if [[ "${actual}" == "${expected}" ]]; then
    echo "  PASS ${description} (${actual})"
    pass=$((pass + 1))
  else
    echo "  FAIL ${description}: expected ${expected}, got ${actual}"
    fail=$((fail + 1))
  fi
}

status() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@" || echo "000"
}

create_link() {
  status -X POST "${BASE_URL}/api/v1/links" \
    -H "content-type: application/json" -H "x-api-key: ${API_KEY}" \
    -d "{\"url\":\"https://example.com/chaos\",\"customCode\":\"$1\"}"
}

wait_ready() {
  for _ in $(seq 1 60); do
    [[ "$(status "${BASE_URL}/ready")" == "200" ]] && return 0
    sleep 1
  done
  echo "  service did not become ready" >&2
  return 1
}

seed() {
  local code="chaos$(date +%s)$RANDOM"
  create_link "${code}" >/dev/null
  echo "${code}"
}

scenario_redis_down() {
  echo "Scenario: Redis unavailable"
  wait_ready
  local code
  code="$(seed)"
  status "${BASE_URL}/${code}" >/dev/null # warm the cache

  "${compose[@]}" stop redis >/dev/null
  sleep 2

  check "redirects fall back to PostgreSQL" 302 "$(status "${BASE_URL}/${code}")"
  check "readiness stays green (PostgreSQL is the source of truth)" 200 "$(status "${BASE_URL}/ready")"
  check "link creation fails closed without rate limiting" 503 "$(create_link "chaosnoredis$RANDOM")"

  "${compose[@]}" start redis >/dev/null
  # The client stops reconnecting after its retry limit; workers restart it.
  "${compose[@]}" restart app >/dev/null
  wait_ready
  check "creation recovers after Redis returns" 201 "$(create_link "chaosback$RANDOM")"
}

scenario_postgres_down() {
  echo "Scenario: PostgreSQL unavailable"
  wait_ready
  local code
  code="$(seed)"
  status "${BASE_URL}/${code}" >/dev/null # cache it in Redis

  "${compose[@]}" stop postgres >/dev/null
  sleep 2

  check "cached redirects keep working" 302 "$(status "${BASE_URL}/${code}")"
  check "readiness reports the outage" 503 "$(status "${BASE_URL}/ready")"

  "${compose[@]}" start postgres >/dev/null
  wait_ready
  check "service recovers" 200 "$(status "${BASE_URL}/ready")"
}

scenario_app_restart() {
  echo "Scenario: graceful restart under load"
  wait_ready
  local code
  code="$(seed)"

  # Traffic during the restart; buffered clicks must be flushed on SIGTERM.
  for _ in $(seq 1 200); do status "${BASE_URL}/${code}" >/dev/null; done
  "${compose[@]}" restart app >/dev/null
  wait_ready
  sleep 2

  local clicks
  clicks="$(curl -s "${BASE_URL}/api/v1/links/${code}" | sed -n 's/.*"clicks":\([0-9]*\).*/\1/p')"
  check "clicks survived the restart" 200 "${clicks}"
}

case "${1:-all}" in
  redis-down) scenario_redis_down ;;
  postgres-down) scenario_postgres_down ;;
  app-restart) scenario_app_restart ;;
  all) scenario_redis_down; scenario_postgres_down; scenario_app_restart ;;
  *) sed -n '2,12p' "$0"; exit 2 ;;
esac

echo
echo "${pass} passed, ${fail} failed"
[[ "${fail}" -eq 0 ]]
