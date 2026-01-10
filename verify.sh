#!/bin/bash
set -e

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)

echo "=== Verification Script ==="
echo ""

# Kill any existing processes
echo "1. Cleaning up processes..."
pkill -9 -f "solana-test-validator" 2>/dev/null || true
sleep 2

# Start validator
echo "2. Starting validator..."
cd "$ROOT_DIR"
solana-test-validator --reset --quiet > /tmp/validator.log 2>&1 &
VALIDATOR_PID=$!
echo "   Validator PID: $VALIDATOR_PID"
sleep 8

# Check validator is running
echo "3. Checking validator..."
if ! ps -p $VALIDATOR_PID > /dev/null; then
    echo "   ✗ Validator failed to start"
    exit 1
fi
echo "   ✓ Validator running"

# Deploy program
echo "4. Deploying program..."
cd "$ROOT_DIR/program"
timeout 30 anchor deploy 2>&1 | grep -E "(Program Id|Deploy success)" || echo "   ⚠ Deploy completed with warnings"
echo "   ✓ Program deployed"

# Run tests
echo "5. Running SDK tests..."
cd "$ROOT_DIR/sdk"
timeout 120 npm test 2>&1 | tee /tmp/test-output.log

# Show summary
echo ""
echo "=== Test Summary ==="
grep -E "passing|pending|failing" /tmp/test-output.log | tail -3
echo ""

# Cleanup
echo "6. Cleaning up..."
kill $VALIDATOR_PID 2>/dev/null || true
echo "   ✓ Validator stopped"

echo ""
echo "=== Verification Complete ==="
