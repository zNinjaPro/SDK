/**
 * Cryptographic types and constants for the epoch-based shielded pool
 */

import { PublicKey } from "@solana/web3.js";

/** BN254 field size for public inputs */
export const BN254_FIELD_SIZE = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617",
);

/** Merkle tree depth per epoch (2^12 = 4,096 deposits per epoch) */
export const MERKLE_DEPTH = 12;

/** Number of leaves per EpochLeafChunk PDA */
export const LEAF_CHUNK_SIZE = 256;

/** Size of a BN254 scalar in bytes */
export const SCALAR_SIZE = 32;

/** Size of a commitment in bytes */
export const COMMITMENT_SIZE = 32;

/** Size of a nullifier in bytes */
export const NULLIFIER_SIZE = 32;

/** Size of an encrypted note tag */
export const TAG_SIZE = 16;

/** Default epoch duration in slots (~2 weeks at 400ms slots) */
export const DEFAULT_EPOCH_DURATION_SLOTS = 3_024_000n;

/** Default grace period before epoch can be garbage collected (~6 months) */
export const DEFAULT_EPOCH_EXPIRY_SLOTS = 38_880_000n;

/** Default finalization delay after epoch ends (~1 day) */
export const DEFAULT_FINALIZATION_DELAY_SLOTS = 216_000n;

/**
 * Epoch state enum matching on-chain representation
 */
export enum EpochState {
  /** Epoch is active and accepting deposits */
  Active = 0,
  /** Epoch is frozen, no more deposits, pending finalization */
  Frozen = 1,
  /** Epoch is finalized with committed root, can be spent from */
  Finalized = 2,
}

/**
 * Information about an epoch
 */
export interface EpochInfo {
  /** Epoch number */
  epoch: bigint;
  /** Slot when epoch started */
  startSlot: bigint;
  /** Slot when epoch ended (0 if still active) */
  endSlot: bigint;
  /** Slot when epoch was finalized (0 if not finalized) */
  finalizedSlot: bigint;
  /** Current state of the epoch */
  state: EpochState;
  /** Finalized merkle root (zero if not finalized) */
  finalRoot: Uint8Array;
  /** Number of deposits in this epoch */
  depositCount: number;
  /** Slot when epoch will expire (can be garbage collected) */
  expirySlot: bigint;
}

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

  /** Position in Merkle tree within the epoch (set on confirmation) */
  leafIndex?: number;

  /** Epoch this note belongs to (set on confirmation) */
  epoch?: bigint;

  /** Nullifier: Hash(commitment, nullifierKey, epoch, leafIndex) */
  nullifier: Uint8Array;

  /** Random entropy for commitment */
  randomness: Uint8Array;

  /** Whether this note has been spent */
  spent?: boolean;

  /** Whether this note is in an expired epoch (needs renewal) */
  expired?: boolean;
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
 * Merkle proof for a leaf in an epoch tree
 */
export interface MerkleProof {
  /** Leaf value (commitment) */
  leaf: Uint8Array;

  /** Leaf index in epoch tree */
  leafIndex: number;

  /** Epoch this proof is for */
  epoch: bigint;

  /** Sibling hashes from leaf to root (MERKLE_DEPTH levels) */
  siblings: Uint8Array[];

  /** Computed or finalized root */
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

  /** Current active epoch */
  currentEpoch: bigint;

  /** Epoch start slot (for current epoch) */
  epochStartSlot: bigint;

  /** Epoch duration in slots */
  epochDurationSlots: bigint;

  /** Expiry period in slots */
  expirySlots: bigint;

  /** Finalization delay in slots */
  finalizationDelaySlots: bigint;

  /** Pool authority */
  authority: PublicKey;

  /** Whether pool is paused */
  paused: boolean;
}

/**
 * Event types emitted by the program
 */
export enum EventType {
  Deposit = "DepositEvent",
  Transfer = "TransferEvent",
  Withdraw = "WithdrawEvent",
  Renew = "RenewEvent",
  EpochRollover = "EpochRolloverEvent",
  EpochFinalized = "EpochFinalizedEvent",
}

/**
 * Deposit event data (v2 epoch-aware)
 */
export interface DepositEvent {
  pool: PublicKey;
  epoch: bigint;
  commitment: Uint8Array;
  leafIndex: number;
  amount: bigint;
  encryptedNote: Uint8Array;
  timestamp: bigint;
}

/**
 * Transfer event data (v2 epoch-aware)
 */
export interface TransferEvent {
  pool: PublicKey;
  spendEpoch: bigint;
  depositEpoch: bigint;
  nullifier1: Uint8Array;
  nullifier2: Uint8Array;
  outputCommitment1: Uint8Array;
  outputCommitment2: Uint8Array;
  leafIndex1: number;
  leafIndex2: number;
  encryptedNotes: Uint8Array[];
  timestamp: bigint;
}

/**
 * Withdraw event data (v2 epoch-aware)
 */
export interface WithdrawEvent {
  pool: PublicKey;
  epoch: bigint;
  nullifier: Uint8Array;
  amount: bigint;
  recipient: PublicKey;
  timestamp: bigint;
}

/**
 * Renew event data
 */
export interface RenewEvent {
  pool: PublicKey;
  oldEpoch: bigint;
  nullifier: Uint8Array;
  newEpoch: bigint;
  newCommitment: Uint8Array;
  newLeafIndex: number;
  encryptedNote: Uint8Array;
  timestamp: bigint;
}

/**
 * Epoch rollover event data
 */
export interface EpochRolloverEvent {
  pool: PublicKey;
  previousEpoch: bigint;
  newEpoch: bigint;
  previousEpochDepositCount: number;
  timestamp: bigint;
}

/**
 * Epoch finalized event data
 */
export interface EpochFinalizedEvent {
  pool: PublicKey;
  epoch: bigint;
  finalRoot: Uint8Array;
  depositCount: number;
  timestamp: bigint;
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

  /** Slots before expiry to warn about note renewal */
  renewalWarningSlots?: bigint;
}

/**
 * Balance information with epoch details
 */
export interface BalanceInfo {
  /** Total balance (spendable + pending + expiring, excludes expired) */
  total: bigint;

  /** Total spendable balance (in finalized, non-expired epochs) */
  spendable: bigint;

  /** Balance in active epoch (pending finalization) */
  pending: bigint;

  /** Balance in epochs approaching expiry (needs renewal) */
  expiring: bigint;

  /** Balance in expired epochs (lost if not renewed) */
  expired: bigint;

  /** Total number of unspent notes */
  noteCount: number;

  /** Number of notes in expiring epochs */
  expiringNoteCount: number;

  /** Number of notes in expired epochs */
  expiredNoteCount: number;

  /** Earliest expiry slot for any note */
  earliestExpiry?: bigint;
}

/**
 * Garbage collection info
 */
export interface GarbageCollectInfo {
  /** Epochs available for garbage collection */
  epochsAvailable: bigint[];

  /** Estimated rent recovery in lamports */
  estimatedRentRecovery: bigint;

  /** Number of accounts to be closed */
  accountsToClose: number;
}
