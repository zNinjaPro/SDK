# Testing Guide

## Quick Start

```bash
# Install dependencies
npm install

# Build the SDK
npm run build

# Run all tests
npm test

# Run only unit tests
npm run test:unit

# Run only E2E tests (requires local validator)
npm run test:e2e
```

## Unit Tests

Unit tests verify individual SDK components without requiring a blockchain connection:

- **KeyManager**: Key generation, derivation, and mnemonic support
- **NoteManager**: Note creation, balance tracking, and UTXO selection
- **Cryptographic Functions**: Hashing, commitments, and nullifiers

```bash
npm run test:unit
```

**Status**: ✅ All 15 unit tests passing

### Cryptography Tests

Commitment and nullifier functions are covered in `tests/crypto.test.ts`:

- 32-byte outputs
- Determinism for identical inputs
- Sensitivity to input changes (value/owner/randomness or key)

Run:

```bash
npm run build
npm test
```

## End-to-End Tests

E2E tests require a local Solana validator with the deployed program:

### Prerequisites

1. **Start Local Validator**:

   ```bash
   npm run e2e:validator  # starts solana-test-validator with sensible defaults
   ```

2. **Deploy Program** (in another terminal):

   ```bash
   cd ../program
   anchor build
   anchor deploy
   ```

3. **Run E2E Tests**:
   ```bash
   cd ../sdk
   npm run test:e2e
   ```

To stop the validator when finished:

```bash
npm run e2e:validator:stop
```

### Funding / Airdrops

- The E2E tests auto-airdrop the payer to avoid rent/fee underfunding across repeated runs. If the faucet is exhausted, restart the validator.
- If you want to pre-fund manually:

  ```bash
  solana airdrop 5 payerPubkey --url http://localhost:8899
  ```

### Optional tracing

- Enable prover traces: `ZK_TRACE_PROVER=1`
- Enable merkle path traces: `ZK_TRACE_MERKLE=1`

Example:

```bash
ZK_TRACE_PROVER=1 ZK_TRACE_MERKLE=1 npm run test:e2e
```

### E2E Test Coverage

- Client initialization and key management
- Balance tracking
- Deposit flow (transparent → shielded)
- Shielded transfers (shielded → shielded)
- Withdrawal flow (shielded → transparent)
- Note management and selection

**Note**: E2E tests will skip most operations if the program is not deployed. They verify the SDK structure and will fully test integration once the validator is running.

### Prover Setup (Optional)

To enable real Groth16 proofs during E2E flows:

1. Install snarkjs

```bash
npm install snarkjs --save
```

2. Configure artifact paths

```bash
export WITHDRAW_WASM_PATH="/absolute/path/to/withdraw.wasm"
export WITHDRAW_ZKEY_PATH="/absolute/path/to/withdraw.zkey"
export TRANSFER_WASM_PATH="/absolute/path/to/transfer.wasm"
export TRANSFER_ZKEY_PATH="/absolute/path/to/transfer.zkey"
```

If `snarkjs` or artifacts are missing, the SDK falls back to zeroed proofs to keep flows operable for development.

## Test Structure

```
sdk/tests/
├── crypto.test.ts          # Commitment/nullifier
├── e2e.test.ts             # Full E2E flow (validator required)
├── e2e_fast.test.ts        # Fast E2E (reduced scope)
├── merkle.zeros.test.ts    # Zero hash chain
├── poseidon.variant.test.ts# Poseidon variant comparison
├── prover.merkleOrder.test.ts # Merkle ordering helper
├── txBuilder.inputs.test.ts   # Formatting of tx inputs
├── txBuilder.pda.test.ts      # PDA derivations
└── unit.test.ts              # Unit tests (KeyManager, NoteManager, crypto)
```

## Writing Tests

### Unit Test Example

```typescript
import { expect } from "chai";
import { KeyManager } from "../src/keyManager";

describe("My Feature", () => {
  it("should work correctly", () => {
    const km = KeyManager.generate();
    expect(km.getSpendingKey().length).to.equal(32);
  });
});
```

### E2E Test Example

```typescript
import { Connection, PublicKey } from "@solana/web3.js";
import { ShieldedPoolClient } from "../src/client";

describe("My Flow", () => {
  it("should complete flow", async () => {
    const client = await ShieldedPoolClient.create({
      connection: new Connection("http://localhost:8899"),
      programId: new PublicKey("..."),
      poolConfig: new PublicKey("..."),
      idl: idl as any,
    });

    // Test your flow
    const balance = await client.getBalance();
    expect(balance).to.equal(0n);
  });
});
```

## Continuous Integration

Tests can be integrated into CI/CD pipelines:

```yaml
# .github/workflows/test.yml
- name: Run SDK Tests
  run: |
    cd sdk
    npm install
    npm run build
    npm run test:unit
```

For E2E tests in CI, you can use GitHub Actions with `solana-test-validator`:

```yaml
- name: Setup Solana
  uses: metaplex-foundation/actions/install-solana@v1
  with:
    version: stable

- name: Start Validator
  run: solana-test-validator &

- name: Deploy Program
  run: |
    cd program
    anchor build
    anchor deploy

- name: Run E2E Tests
  run: |
    cd sdk
    npm run test:e2e
```

## Debugging Tests

### Verbose Output

```bash
npx mocha -r ts-node/register tests/**/*.test.ts --reporter spec
```

### Run Single Test

```bash
npx mocha -r ts-node/register tests/unit.test.ts --grep "should generate random keys"
```

### Debug Mode

```bash
node --inspect-brk ./node_modules/.bin/mocha -r ts-node/register tests/unit.test.ts
```

## Current Status

- ✅ SDK compiles successfully
- ✅ 15/15 unit tests passing
- ⏳ E2E tests ready (awaiting deployed program)
- ⏳ Local validator testing (next step)

## Next Steps

1. Start local validator
2. Deploy shielded pool program
3. Initialize a test pool with mock mint
4. Run full E2E test suite
5. Verify deposit → transfer → withdraw flow
