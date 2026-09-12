#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-8000}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$DIR"

echo "Serving ASL Audio from $DIR at http://localhost:$PORT"
echo "Press Ctrl+C to stop."

if command -v open >/dev/null 2>&1; then
  ( sleep 1 && open "http://localhost:$PORT" ) &
fi

exec python3 -m http.server "$PORT"
