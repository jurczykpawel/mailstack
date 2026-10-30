#!/bin/sh
set -eu
exec node "$(dirname "$0")/worker.mjs" "${1:-status}"
