# End-to-End Guide (Localnet)

This guide walks through a full flow on localnet: deposit → shielded transfer → withdraw, with optional Groth16 proofs.

## Prerequisites

- Solana toolchain installed (`solana --version`)
- Anchor CLI installed (`anchor --version`)
- Node.js + npm
- Optional: `snarkjs` for real proofs

## 1. Start Local Validator

```bash
solana-test-validator --reset --quiet --log /tmp/validator.log &
```

Verify it's running:

```bash
ps -ax | grep solana-test-validator | grep -v grep
```

## 2. Build & Deploy Program (Optional if already deployed)

```bash
cd ../../program
anchor build
anchor deploy
```

Note: Ensure `Anchor.toml` and toolchain versions are compatible.

## 3. Configure Prover (Optional)

Install `snarkjs` and set artifact paths:

```bash
cd ../sdk
npm install snarkjs --save

export WITHDRAW_WASM_PATH="/absolute/path/to/withdraw.wasm"
export WITHDRAW_ZKEY_PATH="/absolute/path/to/withdraw.zkey"
export TRANSFER_WASM_PATH="/absolute/path/to/transfer.wasm"
export TRANSFER_ZKEY_PATH="/absolute/path/to/transfer.zkey"
```

If artifacts or `snarkjs` are missing, the SDK falls back to zeroed proofs so you can still exercise flows.

## 4. Build SDK & Run Simple Deposit

```bash
npm run build
node test-simple.js
```

This script:

- Initializes the pool and accounts
- Performs a deposit
- Triggers immediate scanner rescan
- Syncs the Merkle tree

## 5. Programmatic Flow

Example using `ShieldedPoolClient`:

```typescript
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { ShieldedPoolClient } from "../src/client";

async function main() {
  const connection = new Connection("http://localhost:8899");
  const wallet = Keypair.generate();
  const programId = new PublicKey("...");
  const poolConfig = new PublicKey("...");

  const client = new ShieldedPoolClient({
    connection,
    programId,
    poolConfig,
    payer: wallet,
  });

  await client.init();

  // Deposit
  await client.deposit(1_000_000n);

  // Shielded transfer
  const recipientShieldedAddress = "..."; // obtained from recipient
  await client.transfer(500_000n, recipientShieldedAddress);

  // Withdraw
  const recipientPubkey = Keypair.generate().publicKey;
  await client.withdraw(250_000n, recipientPubkey);
}
```

Under the hood, the client:

- Adds a pending note on deposit, rescans the signature logs, and syncs the Merkle tree
- Uses the prover scaffold via `PROVER_ARTIFACTS` when building transfer/withdraw transactions

## 6. Troubleshooting

- If Merkle proofs are missing post-deposit, ensure the client triggers `scanner.rescanSignature` and `merkleTree.sync()` after sending the transaction.
- If Anchor build fails, validate your Rust toolchain and `Anchor.toml` configuration.
- If proofs fail to generate, confirm `snarkjs` is installed and artifact paths are correct.

## 7. Next Steps

- Replace zeroed proofs with real circuits and verifying keys
- Align circuit public inputs with on-chain verifier
- Expand E2E tests to cover multiple notes, change outputs, and error handling
