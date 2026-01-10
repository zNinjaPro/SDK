#!/usr/bin/env bash
set -euo pipefail

# Stop any running solana-test-validator processes

PIDS=$(ps -ax | grep solana-test-validator | grep -v grep | awk '{print $1}')
if [ -z "$PIDS" ]; then
  echo "No solana-test-validator processes found"
  exit 0
fi

echo "Stopping solana-test-validator: $PIDS"
echo "$PIDS" | xargs -I{} kill {}