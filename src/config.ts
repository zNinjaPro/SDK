// Centralized SDK configuration for epoch-based shielded pool
import path from "path";

// Default paths to circuit artifacts (relative to SDK root)
const CIRCUITS_DIR = path.join(__dirname, "..", "circuits");

export const PROVER_ARTIFACTS = {
  withdraw: {
    wasmPath:
      process.env.WITHDRAW_WASM_PATH ||
      path.join(CIRCUITS_DIR, "withdraw.wasm"),
    zkeyPath:
      process.env.WITHDRAW_ZKEY_PATH ||
      path.join(CIRCUITS_DIR, "withdraw_final.zkey"),
  },
  transfer: {
    wasmPath:
      process.env.TRANSFER_WASM_PATH ||
      path.join(CIRCUITS_DIR, "transfer.wasm"),
    zkeyPath:
      process.env.TRANSFER_ZKEY_PATH ||
      path.join(CIRCUITS_DIR, "transfer_final.zkey"),
  },
  renew: {
    wasmPath:
      process.env.RENEW_WASM_PATH || path.join(CIRCUITS_DIR, "renew.wasm"),
    zkeyPath:
      process.env.RENEW_ZKEY_PATH ||
      path.join(CIRCUITS_DIR, "renew_final.zkey"),
  },
};

export type ProverArtifactsEntry = typeof PROVER_ARTIFACTS.withdraw;

// Epoch timing constants (matching on-chain defaults)
export const EPOCH_TIMING = {
  /** Default epoch duration in slots (~2 weeks at 400ms slots) */
  DEFAULT_DURATION_SLOTS: 3_024_000n,
  /** Default grace period before epoch expires (~6 months) */
  DEFAULT_EXPIRY_SLOTS: 38_880_000n,
  /** Default finalization delay after epoch ends (~1 day) */
  DEFAULT_FINALIZATION_DELAY_SLOTS: 216_000n,
  /** Slots before expiry to warn users about renewal (~1 week) */
  DEFAULT_RENEWAL_WARNING_SLOTS: 1_512_000n,
};

// Merkle tree constants
export const MERKLE_CONFIG = {
  /** Tree depth per epoch (2^12 = 4,096 deposits) */
  DEPTH: 12,
  /** Number of historical roots to keep */
  ROOT_HISTORY: 32,
  /** Leaves per chunk PDA */
  LEAF_CHUNK_SIZE: 256,
  /** Alias for LEAF_CHUNK_SIZE for compatibility */
  LEAVES_PER_CHUNK: 256,
};

// PDA seed prefixes
export const PDA_SEEDS = {
  POOL_CONFIG: "pool_config",
  EPOCH_TREE: "epoch_tree",
  LEAVES: "leaves",
  NULLIFIER: "nullifier",
  VAULT_AUTHORITY: "vault_authority",
  VERIFIER: "verifier",
};
