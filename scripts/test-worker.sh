#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT=$(cd "$(dirname "$0")/.." && pwd)
exec node "$ROOT/scripts/manual/worker.mjs" "${1:-status}"
