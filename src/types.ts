/**
 * Cryptographic types and constants for the shielded pool
 */

import { PublicKey } from "@solana/web3.js";

/** BN254 field size for public inputs */
export const BN254_FIELD_SIZE = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617"
);

/** Merkle tree depth - MUST match circuit compilation parameter */
export const MERKLE_DEPTH = (() => {
  const env = process.env.MERKLE_DEPTH;
  if (env) {
    const n = Number(env);
    if (Number.isInteger(n) && n > 0 && n <= 64) return n;
  }
  return 20;
})();

/** Number of leaves per LeafChunk PDA */
export const LEAF_CHUNK_SIZE = 256;

/** Number of nullifiers per NullifierChunk PDA */
export const NULLIFIER_CHUNK_SIZE = 256;

/** Size of a BN254 scalar in bytes */
export const SCALAR_SIZE = 32;

/** Size of a commitment in bytes */
export const COMMITMENT_SIZE = 32;

/** Size of a nullifier in bytes */
export const NULLIFIER_SIZE = 32;

/** Size of an encrypted note tag */
export const TAG_SIZE = 16;

/**
 * Represents a note (UTXO) in the shielded pool
 */
export interface Note {
  /** Token amount (in lamports/smallest unit) */
  value: bigint;

  /** Token mint address */
  token: PublicKey;

  /** Shielded address of the owner (32 bytes) */
  owner: Uint8Array;

  /** Random blinding factor for commitment */
  blinding: Uint8Array;

  /** Optional memo/message */
  memo?: string;

  // Computed fields
  /** Commitment: Hash(value, token, owner, randomness) - used as leaf in tree */
  commitment: Uint8Array;

  /** Position in Merkle tree */
  leafIndex?: number;

  /** Nullifier: Hash(commitment, nullifierKey) */
  nullifier: Uint8Array;

  /** Random entropy for commitment */
  randomness: Uint8Array;

  /** Whether this note has been spent */
  spent?: boolean;
}

/**
 * Spending keys derived from master seed
 */
export interface SpendingKeys {
  /** Master seed (32 bytes) */
  seed: Uint8Array;

  /** Spending key for signing transactions */
  spendingKey: Uint8Array;

  /** Viewing key for decrypting notes */
  viewingKey: Uint8Array;

  /** Nullifier key for generating nullifiers */
  nullifierKey: Uint8Array;

  /** Public shielded address (derived from keys) */
  shieldedAddress: Uint8Array;
}

/**
 * Merkle proof for a leaf
 */
export interface MerkleProof {
  /** Leaf value */
  leaf: Uint8Array;

  /** Leaf index in tree */
  leafIndex: number;

  /** Sibling hashes from leaf to root (32 levels) */
  siblings: Uint8Array[];

  /** Computed root */
  root: Uint8Array;
}

/**
 * Configuration for a shielded pool
 */
export interface PoolConfig {
  /** Program ID */
  programId: PublicKey;

  /** Pool config PDA */
  poolConfig: PublicKey;

  /** Pool tree PDA */
  poolTree: PublicKey;

  /** Vault authority PDA */
  vaultAuthority: PublicKey;

  /** Vault token account */
  vaultTokenAccount: PublicKey;

  /** Token mint */
  mint: PublicKey;

  /** Token decimals */
  decimals: number;

  /** Chain ID constant */
  chainId: Uint8Array;
}

/**
 * Event types emitted by the program
 */
export enum EventType {
  Deposit = "DepositEventV1",
  ShieldedTransfer = "ShieldedTransferEventV1",
  Withdraw = "WithdrawEventV1",
}

/**
 * Deposit event data
 */
export interface DepositEvent {
  version: number;
  poolId: Uint8Array;
  chainId: Uint8Array;
  cm: Uint8Array;
  leafIndex: bigint;
  newRoot: Uint8Array;
  txAnchor: Uint8Array;
  tag: Uint8Array;
  encryptedNote: Uint8Array;
}

/**
 * Shielded transfer event data
 */
export interface ShieldedTransferEvent {
  version: number;
  poolId: Uint8Array;
  chainId: Uint8Array;
  rootPrev: Uint8Array;
  newRoot: Uint8Array;
  txAnchor: Uint8Array;
  nIn: number;
  nOut: number;
  nfIn: Uint8Array[];
  cmOut: Uint8Array[];
  leafIndexOut: bigint[];
  tagsOut: Uint8Array[];
  encNotes: Uint8Array[];
}

/**
 * Withdraw event data
 */
export interface WithdrawEvent {
  version: number;
  poolId: Uint8Array;
  chainId: Uint8Array;
  rootPrev: Uint8Array;
  newRoot: Uint8Array;
  txAnchor: Uint8Array;
  nIn: number;
  nfIn: Uint8Array[];
  value: bigint;
  recipient: PublicKey;
}

/**
 * Options for creating a shielded pool client
 */
export interface ClientOptions {
  /** Solana RPC endpoint */
  rpcEndpoint?: string;

  /** Whether to auto-sync on initialization */
  autoSync?: boolean;

  /** Enable debug logging */
  debug?: boolean;

  /** Cache directory for storing tree/notes */
  cacheDir?: string;
}
