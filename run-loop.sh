#!/bin/bash
# Runs the CRE payroll simulation every 30 seconds with --broadcast.
# Usage: ./run-loop.sh
# Requires CRE_ETH_PRIVATE_KEY to be set in environment or .env file.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Load .env if present and CRE_ETH_PRIVATE_KEY not already set
if [[ -z "${CRE_ETH_PRIVATE_KEY:-}" && -f .env ]]; then
  export $(grep -E '^(PRIVATE_KEY|CRE_ETH_PRIVATE_KEY)=' .env | head -1 | sed 's/PRIVATE_KEY=/CRE_ETH_PRIVATE_KEY=/')
fi

if [[ -z "${CRE_ETH_PRIVATE_KEY:-}" ]]; then
  echo "ERROR: CRE_ETH_PRIVATE_KEY is not set. Export it or add PRIVATE_KEY to .env"
  exit 1
fi

INTERVAL=${INTERVAL:-30}

echo "Starting payroll simulation loop (every ${INTERVAL}s) — $(date -u)"
echo "Press Ctrl+C to stop."
echo ""

while true; do
  echo "--- $(date -u) ---"
  cre workflow simulate my-workflow --target staging-settings --broadcast || true
  echo ""
  sleep "$INTERVAL"
done
