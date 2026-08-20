#!/usr/bin/env bash
# Start the UN RP map dev server (with editor save support).
# Usage: ./serve.sh [port]        (default 8091)
#        ./serve.sh --detach [port]  run in the background

set -euo pipefail
cd "$(dirname "$0")"

PORT="${1:-8091}"
DETACH=0
if [ "${1:-}" = "--detach" ]; then
  DETACH=1
  PORT="${2:-8091}"
fi

run() {
  if command -v python3 >/dev/null 2>&1; then
    python3 scripts/serve.py "$PORT"
  else
    # NixOS: python3 lives in the nix dev shell
    nix develop --command python3 scripts/serve.py "$PORT"
  fi
}

if [ "$DETACH" = "1" ]; then
  nohup "$0" "$PORT" >/tmp/un-map-serve.log 2>&1 &
  echo "started on http://localhost:$PORT (log: /tmp/un-map-serve.log)"
else
  echo "UN RP map at http://localhost:$PORT  (Ctrl+C to stop)"
  run
fi
