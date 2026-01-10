# Shielded Pool SDK

TypeScript SDK for building privacy-preserving applications on Solana using zero-knowledge proofs.

## Prover Integration

The SDK includes a Groth16 prover scaffold (`src/prover.ts`) that uses `snarkjs` when available to produce real proofs. If `snarkjs` is not installed or artifacts are missing, the scaffold returns zeroed proofs so flows remain operable for development.

### Install

```bash
npm install snarkjs --save
```

### Configure Artifacts

Prover artifact paths are centralized in `src/config.ts` and can be set via environment variables:

```bash
export WITHDRAW_WASM_PATH="/absolute/path/to/withdraw.wasm"
export WITHDRAW_ZKEY_PATH="/absolute/path/to/withdraw.zkey"
export TRANSFER_WASM_PATH="/absolute/path/to/transfer.wasm"
export TRANSFER_ZKEY_PATH="/absolute/path/to/transfer.zkey"
```

Alternatively, update `src/config.ts` directly.

### Usage (Client)

The client passes `PROVER_ARTIFACTS` to the transaction builder automatically:

```typescript
// Withdraw
const sig = await client.withdraw(amount, recipientPublicKey);

// Transfer
const sig2 = await client.transfer(amount, recipientShieldedAddress);
```

## Cryptography

Commitments and nullifiers use Poseidon hashing via async functions in `src/crypto.ts`.

Functions:

- `computeCommitment(value, owner, randomness) => Uint8Array(32)`
- `computeNullifier(commitment, nullifierKey) => Uint8Array(32)`

If Poseidon is unavailable, a SHA-256 fallback is used internally.

## Tests

See `TESTING.md` for full details. Quick commands:

```bash
npm run build             # type-check
npm run test:unit         # fast unit suite
npm run e2e:validator     # start local validator (quiet)
npm run test:e2e          # end-to-end suite (requires validator)
npm run e2e:validator:stop# stop validator
```

`tests/crypto.test.ts` validates commitment/nullifier outputs (length, determinism, input sensitivity).

## Architecture (simplified)

```
                   +------------------+
                   |   User / App     |
                   | (wallet, mnemonic)|
                   +---------+--------+
                             |
                             v
                    +--------+--------+
                    | ShieldedPool    |
                    | Client          |
                    | - KeyManager    |
                    | - NoteManager   |
                    | - Merkle Sync   |
                    | - Prover (w/    |
                    |   snarkjs)      |
                    +--------+--------+
                             |
                             v
                    +--------+--------+
                    | TxBuilder        |
                    | (Solana txs)     |
                    +--------+--------+
                             |
                             v
                 +-----------+-----------+
                 | Solana Program        |
                 | (Anchor)              |
                 | - pool config PDA     |
                 | - verifiers (tx/wd)   |
                 | - nullifier set       |
                 | - leaf chunk PDAs     |
                 | - vault ATA           |
                 +-----------+-----------+
                             |
                             v
                 On-chain accounts / PDAs
```

- Deposit: client builds commitment → TxBuilder sends deposit ix → program appends leaf chunk → client merkle sync updates notes.
- Transfer: client selects notes + merkle proof → Prover creates Groth16 proof → TxBuilder sends transfer ix → program verifies, marks nullifiers, appends change/recipient leaves.
- Withdraw: same proving flow, outputs to transparent recipient and marks nullifier.

## Features

- 🔐 **Privacy by Default**: All transfers are private unless explicitly withdrawn
- 🔑 **HD Key Derivation**: BIP39 mnemonic support for key management
- 🌳 **Merkle Tree Sync**: Efficient reconstruction from on-chain LeafChunk PDAs
- 💰 **UTXO Management**: Automatic note selection and change handling
- ⚡ **Real-Time Updates**: Event subscriptions for instant balance tracking
- 🔍 **Auditability**: Optional viewing key sharing for compliance

## Installation

```bash
npm install @zninja/shielded-pool-sdk
```

## Quick Start

```typescript
import { Connection, Keypair } from "@solana/web3.js";
import { ShieldedPoolClient } from "@zninja/shielded-pool-sdk";

// Initialize client
const connection = new Connection("http://localhost:8899");
const wallet = Keypair.generate();

const client = await ShieldedPoolClient.create(
  connection,
  wallet,
  poolAddress, // Your shielded pool address
  "your twelve word mnemonic here" // Optional: restore keys
);

// Deposit 10 tokens into shielded pool
await client.deposit(10_000_000_000n);

// Check shielded balance
const balance = await client.getBalance();
console.log(`Balance: ${balance}`);

// Private transfer to another user
const recipientAddress = "..."; // Recipient's shielded address
await client.transfer(5_000_000_000n, recipientAddress);

// Withdraw to transparent address
await client.withdraw(3_000_000_000n, recipientPublicKey);
```

## Core Concepts

### Notes (UTXOs)

Each "note" represents a private coin with hidden value and owner:

```typescript
interface Note {
  value: bigint; // Token amount
  token: PublicKey; // Token mint
  owner: Uint8Array; // Shielded address
  blinding: Uint8Array; // Random factor
  commitment: Uint8Array; // Public commitment
  nullifier: Uint8Array; // Prevents double-spend
}
```

### Key Management

```typescript
import { KeyManager } from "@zninja/shielded-pool-sdk";

// Generate new keys
const keys = KeyManager.generate();

// Or restore from mnemonic
const keys = KeyManager.fromMnemonic("your twelve words here");

// Get shielded address (like a Solana pubkey but for privacy)
const address = keys.getShieldedAddressString();
```

### Merkle Tree Synchronization

The SDK automatically reconstructs the Merkle tree from on-chain data:

```typescript
// Sync happens automatically during client.create()
// But you can manually sync:
await client.syncTree();

// Get Merkle proof for creating transactions
const proof = client.getMerkleProof(leafIndex);
```

### Event Scanning

Track your balance in real-time:

```typescript
// Subscribe to new notes
client.on("newNote", (note) => {
  console.log(`Received ${note.value} tokens`);
});

// Subscribe to tree updates
client.on("treeUpdate", (newLeaves) => {
  console.log(`Tree updated with ${newLeaves.length} new leaves`);
});
```

## API Reference

### ShieldedPoolClient

Main client for interacting with the shielded pool.

#### `static create(connection, wallet, poolAddress, mnemonic?)`

Create a new client instance.

- `connection`: Solana Connection
- `wallet`: Wallet for signing transactions
- `poolAddress`: Shielded pool PublicKey
- `mnemonic`: Optional BIP39 mnemonic (generates new if not provided)

Returns: `Promise<ShieldedPoolClient>`

#### `getBalance()`

Get total spendable balance.

Returns: `Promise<bigint>`

#### `getShieldedAddress()`

Get your shielded address for receiving private transfers.

Returns: `Promise<string>`

#### `deposit(amount)`

Deposit tokens into the shielded pool.

- `amount`: Amount in smallest units (lamports)

Returns: `Promise<string>` - Transaction signature

#### `withdraw(amount, recipient)`

Withdraw tokens from shielded pool to transparent address.

- `amount`: Amount to withdraw
- `recipient`: Destination PublicKey

Returns: `Promise<string>` - Transaction signature

#### `transfer(amount, recipientAddress)`

Send private transfer to another shielded address.

- `amount`: Amount to send
- `recipientAddress`: Recipient's shielded address (base58)

Returns: `Promise<string>` - Transaction signature

#### `syncTree()`

Manually sync Merkle tree from chain.

Returns: `Promise<void>`

#### `exportViewingKey()`

Export viewing key for auditing purposes.

Returns: `string` - Base58 encoded viewing key

### KeyManager

Manages cryptographic keys for shielded operations.

#### `static generate()`

Generate new random keys.

#### `static fromMnemonic(mnemonic)`

Restore keys from BIP39 mnemonic.

#### `static fromSeed(seed)`

Restore keys from 32-byte seed.

#### `getSpendingKey()`, `getViewingKey()`, `getNullifierKey()`

Get specialized keys for different operations.

#### `getShieldedAddressString()`

Get shielded address as base58 string.

### NoteManager

Manages note creation and UTXO selection.

#### `static createNote(value, token, owner, memo?)`

Create a new note.

#### `static selectNotes(notes, amount)`

Select optimal notes for spending (greedy algorithm).

#### `static calculateBalance(notes)`

Calculate total balance from notes.

## Examples

### Full Deposit → Transfer → Withdraw Flow

```typescript
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { ShieldedPoolClient } from "@zninja/shielded-pool-sdk";

async function main() {
  const connection = new Connection("http://localhost:8899");
  const wallet = Keypair.generate();
  const poolAddress = new PublicKey("...");

  // Create client
  const alice = await ShieldedPoolClient.create(
    connection,
    wallet,
    poolAddress,
    "alice mnemonic words here"
  );

  // Deposit
  console.log("Depositing 100 tokens...");
  await alice.deposit(100_000_000_000n);

  // Check balance
  const balance = await alice.getBalance();
  console.log(`Alice balance: ${balance}`);

  // Create another client for Bob
  const bob = await ShieldedPoolClient.create(
    connection,
    Keypair.generate(),
    poolAddress,
    "bob mnemonic words here"
  );

  const bobAddress = await bob.getShieldedAddress();

  // Private transfer from Alice to Bob
  console.log("Transferring 50 tokens to Bob...");
  await alice.transfer(50_000_000_000n, bobAddress);

  // Bob's balance updates automatically
  await new Promise((r) => setTimeout(r, 2000)); // Wait for event
  const bobBalance = await bob.getBalance();
  console.log(`Bob balance: ${bobBalance}`);

  // Bob withdraws to transparent address
  const recipient = Keypair.generate().publicKey;
  console.log("Bob withdrawing 30 tokens...");
  await bob.withdraw(30_000_000_000n, recipient);
}
```

### Read-Only Auditing

```typescript
// Alice shares her viewing key with auditor
const viewingKey = alice.exportViewingKey();

// Auditor can see all of Alice's transactions
const auditor = await ShieldedPoolClient.createReadOnly(
  connection,
  poolAddress,
  viewingKey
);

const balance = await auditor.getBalance();
const history = await auditor.getTransactionHistory();
```

## Architecture

```
ShieldedPoolClient
├── KeyManager       # BIP39 keys, shielded addresses
├── NoteManager      # UTXO creation, selection
├── MerkleTreeSync   # Reconstruct tree from chain
├── UTXOScanner      # Event scanning, balance tracking
└── TransactionBuilder  # Build deposit/withdraw/transfer txs
```

## Development Status

### ✅ Implemented

- Key management and derivation
- Note creation and encryption
- Merkle tree reconstruction
- Basic transaction builders
- Type definitions

### 🚧 In Progress

- Event scanning and parsing
- Real-time subscriptions
- UTXO scanner implementation
- Full transaction builders
- ZK proof generation (mock → real)

### 📋 Todo

- Caching layer for performance
- Mobile-friendly proof generation
- Multi-pool support
- Advanced note selection algorithms
- Comprehensive test suite

## Security

⚠️ **This SDK is in active development and has not been audited. Use at your own risk.**

- Never share your spending key
- Always verify transaction details
- Use viewing keys carefully (they reveal all your transactions)
- Keep mnemonics secure and backed up

## Contributing

Contributions welcome! Please see CONTRIBUTING.md for guidelines.

## License

MIT
