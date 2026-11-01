#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT=$(cd "$(dirname "$0")/.." && pwd)
if [[ "${1:-status}" == status ]]; then
  exec node "$ROOT/scripts/staging/test-worker-status.mjs"
fi
exec node "$ROOT/scripts/manual/worker.mjs" "$1"
