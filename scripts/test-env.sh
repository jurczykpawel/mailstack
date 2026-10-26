#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PRO=$(cd "$ROOT/../mailstack-pro" && pwd)
STATE=/private/tmp/mailstack-test-local
export COMPOSE_PARALLEL_LIMIT=1
command=${1:-status}
shift || true
compose() { docker compose -p mailstack-test -f "$STATE/compose.yml" "$@"; }
resources() {
  memory_pressure | awk '/free percentage:/ { print; if ($5+0 < 25) exit 1 }'
  docker compose ls --format json | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{if(JSON.parse(s).some(p=>p.Name!=="mailstack-test"))process.exit(1)})'
}
case "$command" in
  up)
    resources
    if [[ ! -f "$STATE/compose.yml" ]]; then
      [[ ! -e "$STATE" ]] || { echo "Incomplete installation: run down first" >&2; exit 1; }
      mkdir -m 700 "$STATE"
      node "$ROOT/scripts/manual/provision.mjs" "$ROOT" "$PRO" "$STATE"
      TEST_UID=$(id -u); TEST_GID=$(id -g)
      export TEST_UID TEST_GID
      node "$ROOT/scripts/manual/compose.mjs" "$STATE" "$TEST_UID" "$TEST_GID"
    fi
    if ! compose up -d --build --wait --wait-timeout 180; then
      compose logs --tail 50 >&2
      exit 1
    fi
    "$0" status
    ;;
  seed)
    compose exec -T api node /workspace/mailstack-pro/dist/manual-seed.mjs seed
    compose exec -T api node /workspace/mailstack-pro/dist/manual-seed.mjs seed-events
    "$0" invite all
    ;;
  invite)
    roles=${1:-all}; [[ "$roles" != all ]] || roles="viewer operator admin"
    for role in $roles; do
      case "$role" in viewer|operator|admin) ;; *) exit 2;; esac
      compose exec -T panel node dist/panel.mjs invite --role "$role" > "$STATE/invite-$role.txt"
    done
    "$0" status
    ;;
  status)
    [[ -f "$STATE/compose.yml" ]] || { echo 'TEST-LOCAL down'; exit 0; }
    compose ps
    node "$ROOT/scripts/manual/status.mjs" "$STATE"
    ;;
  license)
    variant=${1:-valid}
    node "$ROOT/scripts/manual/license.mjs" "$STATE" "$variant"
    compose restart api panel
    ;;
  mode)
    curl --fail --silent --show-error --cacert "$STATE/fixture/tls.crt" https://localhost:18843/control -H 'content-type: application/json' --data "${1:?JSON modes required}"
    ;;
  exec) compose exec -T "$@" ;;
  logs) compose logs --no-color --tail 100 "$@" ;;
  down)
    if [[ -f "$STATE/compose.yml" ]]; then compose down -v --rmi local --remove-orphans; fi
    [[ "$STATE" == /private/tmp/mailstack-test-local ]] && rm -rf "$STATE"
    ;;
  reset) "$0" down; "$0" up; "$0" seed ;;
  *) echo 'Use up|seed|status|invite [role]|license [variant]|mode JSON|exec SERVICE COMMAND|logs|down|reset' >&2; exit 2 ;;
esac
