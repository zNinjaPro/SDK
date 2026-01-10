#!/usr/bin/env bash
set -euo pipefail

# Start a local Solana test validator with sensible limits for e2e
# Usage: ./scripts/start-validator.sh [--quiet]

QUIET=false
for arg in "$@"; do
  case "$arg" in
    --quiet) QUIET=true ;;
  esac
done

LOGFILE=${LOGFILE:-/tmp/validator.log}
FAUCET_PORT=${FAUCET_PORT:-9900}
RPC_PORT=${RPC_PORT:-8899}
LEDGER_SIZE=${LEDGER_SIZE:-500000000}
SLOTS_PER_EPOCH=${SLOTS_PER_EPOCH:-32}

CMD=(solana-test-validator --reset --limit-ledger-size "$LEDGER_SIZE" --slots-per-epoch "$SLOTS_PER_EPOCH" --faucet-port "$FAUCET_PORT" --rpc-port "$RPC_PORT")
if [ "$QUIET" = true ]; then
  CMD+=(--quiet --log "$LOGFILE")
fi

echo "Starting validator: ${CMD[*]}"
exec "${CMD[@]}"